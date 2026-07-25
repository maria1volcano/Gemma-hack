/*
 * KidGuard service worker (MV3).
 *
 * Owns all network access. Content script and side panel never call the
 * backend directly.
 *
 * Messages it answers (chrome.runtime.sendMessage):
 *   {type:"KG_DECIDE",  payload:{url,title,text,signals?}} -> {ok, tool_calls, kid_message, source}
 *   {type:"KG_COACH",   payload:{message}}                 -> {ok, reply, tool_calls, source}
 *   {type:"KG_NOTIFY_PARENT", payload:{summary,url}}       -> {ok}
 *   {type:"KG_NAVIGATE", payload:{url}}                    -> {ok}
 *   {type:"KG_OPEN_PANEL"}                                 -> {ok} | {ok:false,error:"panel_open_failed"}
 *   {type:"KG_GET_SETTINGS"}                               -> {ok, mock, paused, pause_reason, backend}
 *   {type:"KG_SET_SETTINGS", payload:{mock?,paused?,pause_reason?}} -> {ok, mock, paused}
 *   {type:"KG_RESUME"}                                     -> {ok, paused:false, backend}
 *
 * On any failure it resolves with {ok:false, error:"backend_unreachable"} so the
 * UI can show a toast instead of hanging forever.
 *
 * MV3 note: the worker is killed aggressively, so nothing important lives in
 * top-level state. Settings are always re-read from chrome.storage.local.
 */

const BACKEND = "http://127.0.0.1:8000";
const REQUEST_TIMEOUT_MS = 180000; // Gemma on Brev often needs >20s; parent feed was updating while the page timed out
const SIDE_PANEL_PATH = "sidepanel.html";
// Side panel + page guard run on any normal web page (demo or real site).
const PAGE_URL_RE = /^https?:\/\//;

// Fallback used when chrome.storage has no value yet. Flip to false once
// teammate A's backend is up, or toggle at runtime from the side panel.
const MOCK_DEFAULT = false; // LIVE Gemma backend by default for the hackathon demo

const AGE = 10;

const STORAGE_KEYS = {
  mock: "kidguard_mock",
  paused: "kidguard_paused",
  pauseReason: "kidguard_pause_reason",
  riskCount: "kidguard_risk_count"
};

// Golden demo path: the second block-worthy page of a session pauses it.
const PAUSE_AFTER_RISKS = 99; // was 2; keep demo pages usable in MOCK without freezing
const MOCK_PAUSE_REASON =
  "That is the second risky page in a row, so I am stopping the internet for a little while.";

async function getSettings() {
  const raw = await chrome.storage.local.get([
    STORAGE_KEYS.mock,
    STORAGE_KEYS.paused,
    STORAGE_KEYS.pauseReason
  ]);
  return {
    mock: typeof raw[STORAGE_KEYS.mock] === "boolean" ? raw[STORAGE_KEYS.mock] : MOCK_DEFAULT,
    paused: raw[STORAGE_KEYS.paused] === true,
    pauseReason: typeof raw[STORAGE_KEYS.pauseReason] === "string" ? raw[STORAGE_KEYS.pauseReason] : ""
  };
}

// MV3 kills this worker after ~30 s idle, so the session risk counter cannot be
// a module-level variable: it lives in chrome.storage like every other bit of
// state. Reset by KG_RESUME so a demo can be replayed without reloading.
async function bumpRiskCount() {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.riskCount);
  const current = typeof raw[STORAGE_KEYS.riskCount] === "number" ? raw[STORAGE_KEYS.riskCount] : 0;
  const next = current + 1;
  await chrome.storage.local.set({ [STORAGE_KEYS.riskCount]: next });
  return next;
}

async function postJSON(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(BACKEND + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) return { ok: false, error: "backend_error_" + res.status };
    return { ok: true, data: await res.json() };
  } catch (err) {
    console.warn("[KidGuard] backend call failed", path, err && err.message);
    return { ok: false, error: "backend_unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------- tool calls */

const KNOWN_TOOLS = new Set([
  "allow_page",
  "warn_kid",
  "block_page",
  "pause_session",
  "highlight_element",
  "move_mascot",
  "notify_parent",
  "suggest_alternative",
  "navigate_hint"
]);

const ARG_KEYS = [
  "message",
  "reason",
  "safer_alternative",
  "text_or_css",
  "selector",
  "x_hint",
  "mood",
  "summary",
  "label",
  "url",
  "safe"
];

// Accepts the shapes a Gemma/Ollama style backend might return and flattens
// them to the frozen contract: [{tool, args}].
function normalizeToolCalls(data) {
  if (!data) return [];
  let list = data.tool_calls || data.toolCalls || data.actions || data.tools;
  if (!list && data.action) list = [data];
  if (!Array.isArray(list)) return [];

  const out = [];
  for (const raw of list) {
    if (!raw) continue;
    if (typeof raw === "string") {
      if (KNOWN_TOOLS.has(raw)) out.push({ tool: raw, args: {} });
      continue;
    }
    const fn = raw.function || {};
    const tool = raw.tool || raw.name || raw.action || fn.name;
    let args = raw.args || raw.arguments || raw.params || raw.parameters || fn.arguments || {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch (_) {
        args = {};
      }
    }
    if (!args || typeof args !== "object") args = {};
    // Flat shape: {action:"block_page", reason:"...", safer_alternative:"..."}
    if (Object.keys(args).length === 0) {
      const flat = {};
      for (const k of ARG_KEYS) if (raw[k] !== undefined) flat[k] = raw[k];
      args = flat;
    }
    if (tool && KNOWN_TOOLS.has(tool)) out.push({ tool, args });
  }
  return out;
}

/* --------------------------------------------------------------------- mock */

// Words that mean "this page is trying to take an account / money".
const HARD_SIGNALS = ["password", "verify your account", "login", "log in", "phishing", "sign in to continue"];
// Scam bait. On its own (no form on the page) this is a warn, not a block.
const SCAM_BAIT = ["free robux", "robux generator", "gift card generator", "free v-bucks"];
const CLICKBAIT_SIGNALS = [
  "you won't believe",
  "you wont believe",
  "click here",
  "claim your prize",
  "you have won",
  "winner",
  "giveaway",
  "generator",
  "hurry",
  "limited time",
  "shocking",
  "100% free",
  "no survey"
];

// Hard self-harm / suicide signals (real search pages). Keep kid copy calm.
const SELF_HARM_PATTERNS = [
  /\bsuicid(?:e|al)\b/i,
  /\bself[-\s]?harm(?:ing)?\b/i,
  /\bkill\s+(?:my|your)self\b/i,
  /\bend\s+(?:my|your)\s+life\b/i,
  /\bwant(?:s|ed|ing)?\s+to\s+die\b/i,
  /\bhow\s+to\s+(?:die|kill\s+(?:my|your)self)\b/i
];
const CLASSROOM_URL = "http://127.0.0.1:8765/demo_sites/classroom.html";
const SELF_HARM_BLOCK_REASON =
  "This page talks about really hard feelings in a way that is not okay for you. Let's go somewhere kinder together.";
const SELF_HARM_WARN_MESSAGE = "Let's step away from this page and pick something safer.";
const SELF_HARM_WARN_REASON = "This topic needs a grown-up, not the internet.";
const SELF_HARM_PARENT_SUMMARY =
  "KidGuard hard-blocked a page with self-harm / suicide search or content signals.";

function hits(haystack, needles) {
  return needles.filter((n) => haystack.includes(n));
}

function hasSelfHarmSignal(payload) {
  let url = "";
  try {
    url = decodeURIComponent(String((payload && payload.url) || ""));
  } catch (_) {
    url = String((payload && payload.url) || "");
  }
  const blob = [url, payload && payload.title, payload && payload.text]
    .filter(Boolean)
    .join(" \n ");
  if (!blob.trim()) return false;
  return SELF_HARM_PATTERNS.some((re) => re.test(blob));
}

function selfHarmBlockResult() {
  return {
    kid_message: SELF_HARM_BLOCK_REASON,
    tool_calls: [
      {
        tool: "warn_kid",
        args: { message: SELF_HARM_WARN_MESSAGE, reason: SELF_HARM_WARN_REASON }
      },
      { tool: "move_mascot", args: { x_hint: "left", mood: "worry" } },
      { tool: "suggest_alternative", args: { label: "Go to Classroom", url: CLASSROOM_URL } },
      {
        tool: "block_page",
        args: { reason: SELF_HARM_BLOCK_REASON, safer_alternative: CLASSROOM_URL }
      },
      // After block_page so the content script skips the "told your grown-up" toast.
      { tool: "notify_parent", args: { summary: SELF_HARM_PARENT_SUMMARY } }
    ]
  };
}

function mockDecide(payload) {
  const blob = [payload.url, payload.title, payload.text].filter(Boolean).join(" \n ").toLowerCase();
  const signals = payload.signals || {};
  if (hasSelfHarmSignal(payload)) {
    return selfHarmBlockResult();
  }
  const hard = hits(blob, HARD_SIGNALS);
  const bait = hits(blob, SCAM_BAIT);
  const clickbait = hits(blob, CLICKBAIT_SIGNALS);

  const looksLikeCredentialTrap = hard.length > 0 || (bait.length > 0 && signals.hasPasswordInput === true);

  if (looksLikeCredentialTrap) {
    const reason =
      "This page is asking for a username and password, but it is not a site I recognise. Real sites never ask you to 'verify your account' like this.";
    return {
      kid_message: "Stop! I think this page is trying to steal your account.",
      tool_calls: [
        { tool: "block_page", args: { reason, safer_alternative: "classroom.html" } },
        {
          tool: "highlight_element",
          args: { text_or_css: "#password", message: "Never type your password here." }
        },
        { tool: "move_mascot", args: { x_hint: "center", mood: "worry" } },
        {
          tool: "notify_parent",
          args: { summary: "Blocked a fake login page: " + (payload.title || payload.url || "unknown page") }
        }
      ]
    };
  }

  if (clickbait.length > 0 || bait.length > 0) {
    return {
      kid_message: "Careful - this page really wants you to click.",
      tool_calls: [
        {
          tool: "warn_kid",
          args: {
            message: "This page promises free stuff to get you to click. Free prizes online are almost always a trick.",
            reason: "clickbait signals: " + clickbait.concat(bait).slice(0, 3).join(", ")
          }
        },
        { tool: "move_mascot", args: { x_hint: "right", mood: "worry" } },
        { tool: "suggest_alternative", args: { label: "Go to Classroom instead", url: "classroom.html" } }
      ]
    };
  }

  return {
    kid_message: "This page looks fine to me.",
    tool_calls: [
      { tool: "allow_page", args: {} },
      { tool: "move_mascot", args: { x_hint: "right", mood: "happy" } }
    ]
  };
}

function coachHasTool(calls, name) {
  return (calls || []).some((c) => c && c.tool === name);
}

/** Page-grounded coach recipes (mirrors backend/demo_fast.fast_coach_plan). */
function coachVisualRecipe(message) {
  const m = String(message || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!m) return null;
  const classroomUrl = "http://127.0.0.1:8765/demo_sites/classroom.html";
  const resourcesUrl = "http://127.0.0.1:8765/demo_sites/ok_school.html";

  const highlight = (text, msg, safe = true) => ({
    tool: "highlight_element",
    args: safe
      ? { text_or_css: text, message: msg, safe: true }
      : { text_or_css: text, message: msg }
  });
  const point = (mood = "point") => ({
    tool: "move_mascot",
    args: { x_hint: "target", mood }
  });
  const classroomChip = {
    tool: "suggest_alternative",
    args: { label: "Go to Classroom", url: classroomUrl }
  };
  const resourcesChip = {
    tool: "suggest_alternative",
    args: { label: "School Resources", url: resourcesUrl }
  };

  if (/\b(password|login|phish|robux|free coins)\b/.test(m) || m.includes("free robux")) {
    return {
      reply: "Do not type a password here — I marked the risky box in pink. Use the green safe path instead.",
      tool_calls: [
        classroomChip,
        highlight("password", "Do not type a password here.", false),
        point("worry")
      ]
    };
  }
  if (
    /\b(get out|get me out|leave|exit|escape|stuck|go away|somewhere safe|safe place|take me somewhere|go back|help me out|out of this|classroom|go to school|go to class)\b/.test(
      m
    ) ||
    m.includes("is this safe") ||
    m.includes("is it safe") ||
    m.includes("safe?") ||
    m.includes("feels weird")
  ) {
    return {
      reply: "Follow the glowing green button I am pointing at — that takes you somewhere safer.",
      tool_calls: [
        classroomChip,
        highlight("Classroom", "Tap here to go somewhere safer."),
        point()
      ]
    };
  }
  if (/\bfriday\b|\bfri\b/.test(m)) {
    return {
      reply:
        "On Friday the library is open from 8:30 to 15:00 — I circled Friday for you. Remember to return your books before the weekend!",
      tool_calls: [highlight("Friday", "Friday library hours are right here."), point("happy")]
    };
  }
  if (
    /\b(library|opening hour|open hour|hours|timetable|schedule|what time)\b/.test(m) ||
    m.includes("what on") ||
    m.includes("have on")
  ) {
    return {
      reply: "Library times are in this table — I marked Library opening hours for you.",
      tool_calls: [highlight("Library opening hours", "Check the hours in this table."), point("happy")]
    };
  }
  if (
    /\b(homework tip|study tip|homework help|tips for homework)\b/.test(m) ||
    (/\btips?\b/.test(m) && !m.includes("resource")) ||
    (m.includes("homework") && m.includes("tip")) ||
    (m.includes("study") && m.includes("tip"))
  ) {
    return {
      reply: "Here are homework tips that actually help — I put a green ring on them!",
      tool_calls: [highlight("Homework tips that actually help", "Try these homework tips."), point("happy")]
    };
  }
  if (
    /\b(reading list|book list|books to read|this term)\b/.test(m) ||
    m.includes("what should i read") ||
    (m.includes("read") && (m.includes("book") || m.includes("list")))
  ) {
    return {
      reply: "This term's reading list is up here — pick a book that looks fun!",
      tool_calls: [
        highlight("This term's reading list", "Books for this term live here."),
        point("happy")
      ]
    };
  }
  if (/\b(book swap|coming up|this month|achebe)\b/.test(m)) {
    return {
      reply: "The book swap is coming up this month — I marked that bit for you.",
      tool_calls: [highlight("Coming up this month", "Look at what is coming up."), point("happy")]
    };
  }
  if (/\b(maths|math|fraction|pizza)\b/.test(m)) {
    return {
      reply: "Your maths job is Fraction Pizza — I circled it so you can start there!",
      tool_calls: [highlight("1. Maths: Fraction Pizza", "Start with this maths assignment."), point("happy")]
    };
  }
  if (
    /\b(reading assignment|three pages|reading homework)\b/.test(m) ||
    (m.includes("reading") && (m.includes("assignment") || m.includes("homework") || m.includes("due")))
  ) {
    return {
      reply: "Your reading assignment is Three Pages and a Question — look, I marked it!",
      tool_calls: [highlight("2. Reading: Three Pages and a Question", "This is your reading assignment."), point("happy")]
    };
  }
  if (/\b(science|cloud|clouds)\b/.test(m)) {
    return {
      reply: "Science is Cloud Watch — you already finished it. Nice work!",
      tool_calls: [highlight("3. Science: Cloud Watch", "Your science assignment is here."), point("happy")]
    };
  }
  if (/\b(assignment|assignments|homework|due tuesday|due thursday)\b/.test(m)) {
    return {
      reply: "Your assignments are in this list — I put a green ring on them!",
      tool_calls: [highlight("Your assignments", "Your assignments are right here."), point("happy")]
    };
  }
  if (
    /\b(resource|resources|school resource|assignment help)\b/.test(m) ||
    m.includes("where can i get") ||
    m.includes("where do i find school")
  ) {
    return {
      reply: "School resources are this way — tap the glowing green button I am pointing at.",
      tool_calls: [
        resourcesChip,
        highlight("School Resources", "Tap here for school resources."),
        point()
      ]
    };
  }
  return null;
}

/**
 * If live Gemma forgot highlight/move_mascot, add a small page-grounded visual
 * from the kid message so the mascot still points at something useful.
 */
function enrichCoachVisuals(message, toolCalls, reply) {
  const calls = Array.isArray(toolCalls) ? toolCalls.slice() : [];
  const recipe = coachVisualRecipe(message);
  if (!recipe) {
    return { tool_calls: calls, reply: reply || "" };
  }

  const hasHighlight = coachHasTool(calls, "highlight_element");
  const hasMove = coachHasTool(calls, "move_mascot");
  const recipeHasSuggest = recipe.tool_calls.some((t) => t && t.tool === "suggest_alternative");
  const recipeHighlight = recipe.tool_calls.find((t) => t && t.tool === "highlight_element");
  const genericSafer =
    /^tap the button below/i.test(String(reply || "")) ||
    (/somewhere safer/i.test(String(reply || "")) && coachHasTool(calls, "suggest_alternative"));

  // Kid asked a page-grounded question (Friday, tips, …) but Gemma only offered Classroom.
  if (!recipeHasSuggest && genericSafer) {
    return { tool_calls: recipe.tool_calls.slice(), reply: recipe.reply };
  }

  // Replace short/weak highlight queries (e.g. "tips") with the page-grounded recipe.
  if (hasHighlight && recipeHighlight) {
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      if (!c || c.tool !== "highlight_element") continue;
      const q = String((c.args && (c.args.text_or_css || c.args.selector || c.args.text)) || "").trim();
      if (q.length > 0 && q.length < 12) {
        calls[i] = {
          tool: "highlight_element",
          args: Object.assign({}, c.args || {}, recipeHighlight.args || {})
        };
      }
    }
  }

  if (hasHighlight && hasMove) {
    return { tool_calls: calls, reply: reply || recipe.reply };
  }

  for (const t of recipe.tool_calls) {
    if (!t || !t.tool) continue;
    if (t.tool === "highlight_element" && hasHighlight) continue;
    if (t.tool === "move_mascot" && hasMove) continue;
    if (t.tool === "suggest_alternative" && coachHasTool(calls, "suggest_alternative")) continue;
    calls.push(t);
  }

  const outReply =
    reply && !/^tap the button below/i.test(String(reply))
      ? reply
      : recipe.reply || reply || "";
  return { tool_calls: calls, reply: outReply };
}

function mockCoach(message) {
  const recipe = coachVisualRecipe(message);
  if (recipe) return recipe;
  return {
    reply: "Tell me what you need — homework, library times, or a safer page — and I will point to it.",
    tool_calls: [{ tool: "move_mascot", args: { x_hint: "right", mood: "happy" } }]
  };
}

/* ----------------------------------------------------------------- handlers */

async function handleDecide(payload, sender) {
  // Pre-arm the side panel for this tab so the later "Ask my buddy" click only
  // has to call open() - setOptions() inside the click would burn the gesture.
  ensurePanelEnabled(sender && sender.tab && sender.tab.id);

  const { mock, paused, pauseReason } = await getSettings();
  const ctx = {
    url: payload && payload.url,
    title: payload && payload.title,
    text: payload && payload.text,
    signals: (payload && payload.signals) || {}
  };

  // The content script already stops asking while paused; this is the second
  // lock, so a stray call can never wake the slow model during a break.
  if (paused) {
    return { ok: true, source: "paused", paused: true, pause_reason: pauseReason, kid_message: "", tool_calls: [] };
  }

  // Hard self-harm / suicide: block immediately (mock or live) — never wait on Gemma.
  if (hasSelfHarmSignal(ctx)) {
    const result = selfHarmBlockResult();
    const calls = result.tool_calls.slice();
    if (calls.some((c) => c && c.tool === "block_page")) {
      const risks = await bumpRiskCount();
      if (risks >= PAUSE_AFTER_RISKS) {
        calls.push({ tool: "pause_session", args: { reason: MOCK_PAUSE_REASON } });
      }
    }
    return {
      ok: true,
      source: "fast_risk",
      paused,
      kid_message: result.kid_message,
      tool_calls: calls
    };
  }

  if (mock) {
    const result = mockDecide(ctx);
    const calls = result.tool_calls.slice();
    if (calls.some((c) => c && c.tool === "block_page")) {
      const risks = await bumpRiskCount();
      if (risks >= PAUSE_AFTER_RISKS) {
        calls.push({ tool: "pause_session", args: { reason: MOCK_PAUSE_REASON } });
      }
    }
    return { ok: true, source: "mock", paused, kid_message: result.kid_message, tool_calls: calls };
  }

  // Frozen backend body: extra local-only fields (signals) are not sent.
  const res = await postJSON("/decide", { url: ctx.url, title: ctx.title, text: ctx.text, age: AGE });
  if (!res.ok) return { ok: false, error: res.error, paused };

  const data = res.data || {};
  return {
    ok: true,
    source: "backend",
    paused,
    kid_message: data.kid_message || data.message || "",
    tool_calls: normalizeToolCalls(data)
  };
}

async function applyCoachVisuals(toolCalls, reply) {
  // Drive the open page: highlight, mascot, chips — same tools as /decide.
  if (!Array.isArray(toolCalls) || !toolCalls.length) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || typeof tab.id !== "number") return;
    if (!PAGE_URL_RE.test(tab.url || "")) return;
    await chrome.tabs.sendMessage(tab.id, {
      type: "KG_RUN_TOOLS",
      payload: { tool_calls: toolCalls, from_coach: true, reply: reply || "" }
    });
  } catch (err) {
    console.warn("[KidGuard] coach visuals failed", err && err.message);
  }
}

async function handleCoach(message) {
  const { mock, paused } = await getSettings();
  if (mock) {
    const result = mockCoach(message);
    await applyCoachVisuals(result.tool_calls, result.reply);
    return { ok: true, source: "mock", paused, reply: result.reply, tool_calls: result.tool_calls };
  }

  const res = await postJSON("/coach", { message: message });
  if (!res.ok) return { ok: false, error: res.error, paused };

  const data = res.data || {};
  const rawCalls = normalizeToolCalls(data);
  const rawReply = data.reply || data.kid_message || data.message || "(no answer)";
  // Fast demo already ships full visuals; still enrich live Gemma gaps.
  const enriched =
    data.source === "fast_demo"
      ? { tool_calls: rawCalls, reply: rawReply }
      : enrichCoachVisuals(message, rawCalls, rawReply);
  await applyCoachVisuals(enriched.tool_calls, enriched.reply);
  return {
    ok: true,
    source: data.source || "backend",
    paused,
    reply: enriched.reply,
    tool_calls: enriched.tool_calls
  };
}

async function handleNotifyParent(payload) {
  const summary = (payload && payload.summary) || "";
  console.log("[KidGuard] notify_parent:", summary);
  const { mock } = await getSettings();
  if (mock) return { ok: true, source: "mock" };
  const res = await postJSON("/notify", { summary: summary, url: (payload && payload.url) || "" });
  return res.ok ? { ok: true, source: "backend" } : { ok: false, error: res.error };
}

/*
 * Resume works in both worlds: the backend is told when it is the one holding
 * the pause (LIVE mode), and the local flag is cleared either way so the MOCK
 * demo never depends on a running FastAPI. Clearing kidguard_paused is what
 * makes every open tab drop its break screen (storage.onChanged in content.js).
 */
async function handleResume() {
  const { mock } = await getSettings();
  let backend = "skipped";
  if (!mock) {
    const res = await postJSON("/resume", {});
    backend = res.ok ? "ok" : res.error;
  }
  await chrome.storage.local.set({
    [STORAGE_KEYS.paused]: false,
    [STORAGE_KEYS.pauseReason]: "",
    [STORAGE_KEYS.riskCount]: 0
  });
  return { ok: true, paused: false, backend };
}

async function handleNavigate(payload, sender) {
  const url = payload && payload.url;
  if (!url) return { ok: false, error: "no_url" };
  const tabId = sender && sender.tab && sender.tab.id;
  try {
    if (typeof tabId === "number") {
      await chrome.tabs.update(tabId, { url: url });
    } else {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!active) return { ok: false, error: "no_tab" };
      await chrome.tabs.update(active.id, { url: url });
    }
    return { ok: true };
  } catch (err) {
    console.warn("[KidGuard] navigate failed", err && err.message);
    return { ok: false, error: "navigate_failed" };
  }
}

/*
 * chrome.sidePanel.open() only works while the caller's user gesture is still
 * live, and the gesture barely survives the content-script -> worker message
 * hop. Two rules keep this as reliable as Chrome allows:
 *   1. never await anything before calling open() (that always kills it),
 *   2. always answer, so the page can fall back to "click the toolbar icon".
 */
function openPanelNow(sender) {
  const tab = (sender && sender.tab) || {};
  const tabId = typeof tab.id === "number" ? tab.id : null;
  const windowId = typeof tab.windowId === "number" ? tab.windowId : null;

  if (!chrome.sidePanel || !chrome.sidePanel.open) {
    return Promise.resolve({ ok: false, error: "panel_unavailable" });
  }
  if (tabId === null && windowId === null) {
    return Promise.resolve({ ok: false, error: "no_tab" });
  }

  let first;
  try {
    first = tabId !== null ? chrome.sidePanel.open({ tabId: tabId }) : chrome.sidePanel.open({ windowId: windowId });
  } catch (err) {
    first = Promise.reject(err);
  }

  return Promise.resolve(first)
    .then(() => ({ ok: true }))
    .catch((err) => {
      console.warn("[KidGuard] sidePanel.open(tabId) failed", err && err.message);
      if (windowId === null || tabId === null) {
        return { ok: false, error: "panel_open_failed", detail: err && err.message };
      }
      // Window-scoped open sometimes succeeds where the tab-scoped one does not.
      return Promise.resolve()
        .then(() => chrome.sidePanel.open({ windowId: windowId }))
        .then(() => ({ ok: true }))
        .catch((err2) => {
          console.warn("[KidGuard] sidePanel.open(windowId) failed", err2 && err2.message);
          ensurePanelEnabled(tabId);
          return { ok: false, error: "panel_open_failed", detail: err2 && err2.message };
        });
    });
}

// Fire-and-forget. getOptions() first because re-setting the path on a tab whose
// panel is already open would reload it and wipe the kid's chat.
function ensurePanelEnabled(tabId) {
  if (typeof tabId !== "number") return;
  if (!chrome.sidePanel || !chrome.sidePanel.setOptions) return;

  const apply = () => {
    try {
      const p = chrome.sidePanel.setOptions({ tabId: tabId, path: SIDE_PANEL_PATH, enabled: true });
      if (p && p.catch) p.catch((err) => console.warn("[KidGuard] setOptions", err && err.message));
    } catch (err) {
      console.warn("[KidGuard] setOptions threw", err && err.message);
    }
  };

  try {
    if (!chrome.sidePanel.getOptions) {
      apply();
      return;
    }
    chrome.sidePanel
      .getOptions({ tabId: tabId })
      .then((opts) => {
        const samePath = opts && typeof opts.path === "string" && opts.path.indexOf(SIDE_PANEL_PATH) !== -1;
        if (opts && opts.enabled === true && samePath) return; // already armed
        apply();
      })
      .catch(apply);
  } catch (_) {
    apply();
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  // Handled before any await so the user gesture is still valid.
  if (msg.type === "KG_OPEN_PANEL") {
    openPanelNow(sender).then(sendResponse, (err) => {
      console.warn("[KidGuard] open panel crashed", err);
      sendResponse({ ok: false, error: "panel_open_failed" });
    });
    return true;
  }

  const run = async () => {
    switch (msg.type) {
      case "KG_DECIDE":
        return handleDecide(msg.payload || {}, sender);
      case "KG_COACH":
        return handleCoach((msg.payload || {}).message);
      case "KG_NOTIFY_PARENT":
        return handleNotifyParent(msg.payload || {});
      case "KG_NAVIGATE":
        return handleNavigate(msg.payload || {}, sender);
      case "KG_RESUME":
        return handleResume();
      case "KG_GET_SETTINGS": {
        const s = await getSettings();
        return { ok: true, mock: s.mock, paused: s.paused, pause_reason: s.pauseReason, backend: BACKEND };
      }
      case "KG_SET_SETTINGS": {
        const p = msg.payload || {};
        const patch = {};
        if (typeof p.mock === "boolean") patch[STORAGE_KEYS.mock] = p.mock;
        if (typeof p.paused === "boolean") patch[STORAGE_KEYS.paused] = p.paused;
        if (typeof p.pause_reason === "string") patch[STORAGE_KEYS.pauseReason] = p.pause_reason;
        if (Object.keys(patch).length) await chrome.storage.local.set(patch);
        const s = await getSettings();
        return { ok: true, mock: s.mock, paused: s.paused, pause_reason: s.pauseReason };
      }
      default:
        return { ok: false, error: "unknown_message" };
    }
  };

  run().then(sendResponse, (err) => {
    console.warn("[KidGuard] handler crashed", err);
    sendResponse({ ok: false, error: "backend_unreachable" });
  });
  return true; // async response
});

chrome.runtime.onInstalled.addListener(async () => {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.mock);
  if (typeof raw[STORAGE_KEYS.mock] !== "boolean") {
    await chrome.storage.local.set({ [STORAGE_KEYS.mock]: MOCK_DEFAULT });
  }
  // Reloading the extension starts a fresh session: never boot into a pause.
  await chrome.storage.local.set({
    [STORAGE_KEYS.paused]: false,
    [STORAGE_KEYS.pauseReason]: "",
    [STORAGE_KEYS.riskCount]: 0
  });
});

// Keep the panel armed for demo tabs even if no decision ran on them yet.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!info || (info.status !== "loading" && info.status !== "complete")) return;
  if (PAGE_URL_RE.test((tab && tab.url) || "")) ensurePanelEnabled(tabId);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (PAGE_URL_RE.test((tab && tab.url) || "")) ensurePanelEnabled(tabId);
  } catch (_) {
    /* tab vanished */
  }
});

if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn("[KidGuard] setPanelBehavior", err && err.message));
}
