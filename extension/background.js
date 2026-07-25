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
const DEMO_URL_RE = /^https?:\/\/(127\.0\.0\.1|localhost):8765\//;

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
  "url"
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

function hits(haystack, needles) {
  return needles.filter((n) => haystack.includes(n));
}

function mockDecide(payload) {
  const blob = [payload.url, payload.title, payload.text].filter(Boolean).join(" \n ").toLowerCase();
  const signals = payload.signals || {};
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

function mockCoach(message) {
  const m = String(message || "").toLowerCase();
  if (m.includes("classroom") || m.includes("homework") || m.includes("school")) {
    return {
      reply: "Sure! Classroom is a safe place. I put a button below - tap it and I will take you there.",
      tool_calls: [{ tool: "suggest_alternative", args: { label: "Open Classroom", url: "classroom.html" } }]
    };
  }
  if (m.includes("password") || m.includes("robux") || m.includes("free")) {
    return {
      reply:
        "Good question. If a site promises free things or asks for your password, it is almost always a trick. Never type a password unless a grown-up says it is OK.",
      tool_calls: []
    };
  }
  return {
    reply: "I am here to help you stay safe online. Ask me about a page, or ask me to take you somewhere safe.",
    tool_calls: []
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

async function handleCoach(message) {
  const { mock, paused } = await getSettings();
  if (mock) {
    const result = mockCoach(message);
    return { ok: true, source: "mock", paused, reply: result.reply, tool_calls: result.tool_calls };
  }

  const res = await postJSON("/coach", { message: message });
  if (!res.ok) return { ok: false, error: res.error, paused };

  const data = res.data || {};
  return {
    ok: true,
    source: "backend",
    paused,
    reply: data.reply || data.kid_message || data.message || "(no answer)",
    tool_calls: normalizeToolCalls(data)
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
  if (DEMO_URL_RE.test((tab && tab.url) || "")) ensurePanelEnabled(tabId);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (DEMO_URL_RE.test((tab && tab.url) || "")) ensurePanelEnabled(tabId);
  } catch (_) {
    /* tab vanished */
  }
});

if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn("[KidGuard] setPanelBehavior", err && err.message));
}
