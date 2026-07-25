/* KidGuard side panel: kid coach chat. All network goes through background.js. */

const logEl = document.getElementById("log");
const chipsEl = document.getElementById("chips");
const formEl = document.getElementById("form");
const inputEl = document.getElementById("input");
const sendEl = document.getElementById("send");
const statusEl = document.getElementById("status");
const modeEl = document.getElementById("mode");
const resumeEl = document.getElementById("resume");
const toastEl = document.getElementById("toast");

let paused = false;
let pauseReason = "";
let busy = false;

function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: "extension_context" });
          return;
        }
        resolve(res || { ok: false, error: "no_response" });
      });
    } catch (_) {
      resolve({ ok: false, error: "extension_context" });
    }
  });
}

function addMessage(who, text) {
  const el = document.createElement("div");
  el.className = "msg " + who;
  el.textContent = text;
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
  return el;
}

function showThinking() {
  const el = document.createElement("div");
  el.className = "thinking";
  el.innerHTML = '<div class="spinner"></div><span>Gemma is thinking...</span>';
  logEl.appendChild(el);
  logEl.scrollTop = logEl.scrollHeight;
  return el;
}

let toastTimer = 0;
function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2800);
}

function setBusy(state) {
  busy = state;
  const disabled = busy || paused;
  inputEl.disabled = disabled;
  sendEl.disabled = disabled;
  inputEl.placeholder = paused ? "Session paused - ask a grown-up" : "Ask your buddy...";
}

function renderChips(toolCalls) {
  chipsEl.textContent = "";
  if (!Array.isArray(toolCalls)) return;
  for (const call of toolCalls) {
    if (!call) continue;
    const args = call.args || {};
    if (call.tool !== "suggest_alternative" && call.tool !== "navigate_hint") continue;
    const url = args.url;
    if (!url) continue;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = args.label || "Go here";
    chip.addEventListener("click", async () => {
      const target = /^https?:/i.test(url) ? url : "http://127.0.0.1:8765/demo_sites/" + url.replace(/^\.?\//, "");
      const res = await send({ type: "KG_NAVIGATE", payload: { url: target } });
      if (!res.ok) toast("I could not open that page.");
    });
    chipsEl.appendChild(chip);
  }
}

async function refreshSettings() {
  const res = await send({ type: "KG_GET_SETTINGS" });
  if (!res.ok) {
    modeEl.textContent = "?";
    return;
  }
  paused = res.paused === true;
  pauseReason = typeof res.pause_reason === "string" ? res.pause_reason : "";
  modeEl.textContent = res.mock ? "MOCK" : "LIVE";
  modeEl.title = res.mock ? "Using built-in mock answers. Click for live backend." : "Using " + res.backend;
  statusEl.textContent = paused
    ? pauseReason
      ? "Session paused - " + pauseReason
      : "Session paused"
    : res.mock
      ? "Ready (mock mode)"
      : "Ready to help";
  document.body.classList.toggle("paused", paused);
  setBusy(busy);
}

modeEl.addEventListener("click", async () => {
  const current = await send({ type: "KG_GET_SETTINGS" });
  if (!current.ok) return;
  await send({ type: "KG_SET_SETTINGS", payload: { mock: !current.mock } });
  await refreshSettings();
  toast(modeEl.textContent === "MOCK" ? "Mock mode on" : "Live backend mode on");
});

// Parent control: clears the pause everywhere (the content scripts watch the
// storage flag) and resets the session risk counter so the demo can be re-run.
resumeEl.addEventListener("click", async () => {
  resumeEl.disabled = true;
  const res = await send({ type: "KG_RESUME" });
  resumeEl.disabled = false;
  if (!res.ok) {
    toast("Could not resume - reload the extension.");
    return;
  }
  await refreshSettings();
  addMessage("system", "A grown-up resumed the session.");
  toast(res.backend === "ok" ? "Session resumed (backend told)" : "Session resumed");
});

// The pause is decided in a tab, not here: follow the shared flag.
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes && changes.kidguard_paused) refreshSettings();
  });
} catch (_) {
  /* older Chrome without storage events: the next message refreshes anyway */
}

function speakBuddy(text) {
  const line = String(text || "").trim();
  if (!line || !window.speechSynthesis) return;
  try {
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(line.slice(0, 280));
    utter.rate = 1.05;
    utter.pitch = 1.1;
    window.speechSynthesis.speak(utter);
  } catch (_) {
    /* speech is optional */
  }
}

async function askCoach(text) {
  const message = String(text || "").trim();
  if (!message || busy || paused) return;

  inputEl.value = "";
  addMessage("kid", message);
  setBusy(true);
  const thinking = showThinking();

  const res = await send({ type: "KG_COACH", payload: { message: message } });
  thinking.remove();
  setBusy(false);

  if (!res.ok) {
    toast(res.error === "backend_unreachable" ? "My buddy timed out or is offline." : "Something went wrong.");
    addMessage("system", "I could not reach Gemma. Wait up to a minute, then try again.");
    return;
  }

  if (res.paused !== undefined) paused = res.paused === true;
  const reply = res.reply || "(no answer)";
  addMessage("buddy", reply);
  speakBuddy(reply);
  renderChips(res.tool_calls);
  setBusy(false);
  refreshSettings();
}

formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  await askCoach(inputEl.value);
});

addMessage(
  "buddy",
  "Hi! I am your KidGuard buddy. Type a message and I will help."
);
refreshSettings();
