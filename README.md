# KidGuard - Chrome extension + demo kit

KidGuard is a patient internet buddy for kids aged 8-11. A Chrome MV3 extension
scrapes the current page, a local FastAPI backend asks **Gemma 4** what to do,
and Gemma answers with **tool calls** the extension executes on the page: warn
banner, blocking interstitial, highlight ring, parent notify, and a 3D mascot.

**Track:** Autonomous Agents (Gemma 4 Hackathon)

## Quick start (macOS — LIVE Gemma demo)

```bash
# 1) GPU model tunnel (NVIDIA Brev instance must be Running)
brev port-forward bs7vrlon8 -p 11435:11434

# 2) Backend (other terminal)
cd "/Users/youssef/Python Projects/Gemma-hack"
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp -n .env.example .env   # OLLAMA_HOST=http://127.0.0.1:11435  MODEL=gemma4:latest
uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload

# 3) Demo pages (third terminal)
python3 -m http.server 8765 --bind 127.0.0.1
```

Chrome:

1. `chrome://extensions` → Developer mode → **Load unpacked** → select `extension/`
2. Open the KidGuard side panel
3. Ensure the badge says **LIVE** (click if it still says MOCK)
4. Click **Parent: resume session** once
5. Open http://127.0.0.1:8765/demo_sites/phishing.html

Parent feed: http://127.0.0.1:8765/frontend/parent.html  
Writeup draft: [`writeup/KAGGLE_WRITEUP.md`](writeup/KAGGLE_WRITEUP.md)  
Demo script: [`writeup/DEMO_SCRIPT.md`](writeup/DEMO_SCRIPT.md)

Contract check: `bash scripts/check_contract.sh`

Everything below also works **without the backend** in MOCK mode.

## Repo layout (Person B scope)


```text
extension/
  manifest.json      MV3 manifest
  background.js      service worker: all network + MOCK decisions
  content.js         page scrape + tool executor + mascot seam
  overlay.css        warn / block / ring / chips / toast / placeholder mascot
  sidepanel.html     kid coach chat
  sidepanel.js
  lib/               teammate C drops the Three.js mascot here (web-accessible)
  assets/            mascot textures / models (web-accessible)
demo_sites/          ok_school.html, clickbait.html, phishing.html, classroom.html
frontend/parent.html live parent event feed (polls GET /events)
scripts/             serve_demo.ps1|.sh, demo.ps1|.sh
                     check_contract.ps1|.sh + fixtures/  backend contract check
```

## Run the demo (Windows / PowerShell)

```powershell
# static server for the demo pages + parent feed (port 8765)
.\scripts\serve_demo.ps1

# or everything at once (also starts uvicorn if backend/main.py exists)
.\scripts\demo.ps1
```

Then load the extension:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `extension/` folder of this repo
5. Pin the KidGuard icon; clicking it opens the side-panel coach

Demo URLs:

| Page | URL | Expected |
|------|-----|----------|
| Index | http://127.0.0.1:8765/demo_sites/index.html | - |
| OK school page | http://127.0.0.1:8765/demo_sites/ok_school.html | `allow_page` + happy mascot |
| Clickbait | http://127.0.0.1:8765/demo_sites/clickbait.html | `warn_kid` + worried mascot |
| Fake phishing | http://127.0.0.1:8765/demo_sites/phishing.html | `block_page` + `highlight_element(#password)` + `notify_parent` |
| Fake phishing, 2nd hit | same URL again (reload) | the above **+ `pause_session`** -> calm break screen on every page |
| Classroom (safe) | http://127.0.0.1:8765/demo_sites/classroom.html | `allow_page` |
| Parent feed | http://127.0.0.1:8765/frontend/parent.html | timeline from `GET /events` |

The content script is only injected on `http://127.0.0.1:8765/*` and
`http://localhost:8765/*`, minus `frontend/*` and `demo_sites/index.html` —
those pages *describe* the demo pages, so scraping them would trip the keyword
rules and block the parent dashboard. After editing extension files, hit the reload arrow
on the KidGuard card in `chrome://extensions`, then reload the demo page.

## MOCK mode

`background.js` never needs the backend to demo. Mock rules:

- page url/title/text contains `password`, `verify your account`, `login`,
  `phishing` (or a scam-bait phrase such as `free robux` **on a page that has a
  password input**) -> `block_page` + `highlight_element` + `move_mascot(worry)`
  + `notify_parent`
- clickbait signals (`you won't believe`, `claim your prize`, `generator`,
  `free robux`, ...) -> `warn_kid` + `move_mascot(worry)` + `suggest_alternative`
- otherwise -> `allow_page` + `move_mascot(happy)`
- every block-worthy decision bumps `kidguard_risk_count` in `chrome.storage`
  (not a variable: MV3 kills the worker after ~30 s idle). On the **second** one
  the answer also carries `pause_session` — that is step 4 of the golden demo
  path, reproducible with no backend: open `phishing.html`, then open or reload
  it again. "Parent: resume session" in the side panel clears the pause *and*
  the counter, so the run can be repeated.

> Deviation worth knowing: the spec listed `free robux` as a hard block signal,
> but `clickbait.html` contains "FREE ROBUX GENERATOR" and the golden demo path
> needs it to *warn*, not block. So scam-bait phrases only escalate to a block
> when the page also has a password input. Every other keyword blocks as
> specified.

Toggling MOCK:

- **From the UI:** open the side panel and click the `MOCK` / `LIVE` badge in
  the header.
- **From code:** `const MOCK_DEFAULT = false;` at the top of `background.js` (LIVE by default).
- **From the console:** on the service-worker devtools console
  (`chrome://extensions` -> KidGuard -> "service worker"):

```js
chrome.storage.local.set({ kidguard_mock: false }); // use the real backend
chrome.storage.local.set({ kidguard_mock: true });  // back to mock
```

## Frozen tool contract (do not rename)

The content script executes exactly these tools:

| Tool | Args | Effect on the page |
|------|------|--------------------|
| `allow_page` | - | clears overlays, mascot happy |
| `warn_kid` | `message`, `reason` | dismissible kid-friendly banner |
| `block_page` | `reason`, `safer_alternative` | full-page interstitial; "Take me somewhere safe" navigates to `safer_alternative`, "Ask my buddy" opens the side panel |
| `pause_session` | `reason` | calm full-page break screen for the **whole session**, not one page; persisted, survives navigation, no kid-facing unpause button (see below) |
| `highlight_element` | `text_or_css`, `message` | pulsing ring + tooltip over the element, follows scroll/resize, scrolls into view |
| `move_mascot` | `x_hint`, `mood` | `x_hint` = `left`/`center`/`right`/`target`/number of px; `mood` in `idle`, `worry`, `happy`, `point` |
| `notify_parent` | `summary` | forwarded to the service worker + tiny toast |
| `suggest_alternative` | `label`, `url` | green safe-link chip |
| `navigate_hint` | `url` | blue "go here" chip; real navigation via `chrome.tabs` |

`highlight_element` resolves `text_or_css` through a chain, most precise first:

1. valid CSS selector (an invalid one never throws, it just falls through)
2. bare token treated as an id / `name` / `data-testid` (`password` -> `#password`)
3. exact visible-text match on an interactive element
4. partial case-insensitive text match on buttons / links / inputs / labels
5. `aria-label` / `placeholder` / `name` / `value` / `title` / `alt` / `id` match
6. exact text match on a plain text block (heading, list item, ...)

A `<label>` hit is redirected to the field it labels. If nothing matches, the
lookup is retried at 200 / 450 / 900 ms (the DOM may still be settling) and then
degrades to a visible toast carrying the coach message - never a silent no-op.
The ring follows the element via a rAF-throttled scroll/resize listener plus a
`ResizeObserver`, and is torn down whenever a new decision arrives, so rings
never accumulate. Relative URLs in `safer_alternative` and `suggest_alternative`
are resolved against the current page.

### `pause_session` and resuming

`block_page` is about *this page*; `pause_session` is about *the session*, so it
looks different on purpose: no dark scrim and no buttons, just a soft light
break screen ("Let's take a break", the reason in kid language, and "Your
grown-up can unpause this from the KidGuard buddy panel"). The mascot gets the
usual `kidguard:mascot` event with mood `worry`.

The paused state is the one the side panel already knew about:
`chrome.storage.local.kidguard_paused` (plus `kidguard_pause_reason`), written
through the worker's `KG_SET_SETTINGS`. Consequences:

- **It survives navigation.** `content.js` reads the flag before it asks for a
  decision, so any page opened during a pause paints the break screen straight
  away, with no `/decide` round-trip.
- **No decisions while paused.** The content script stops asking and the worker
  refuses to answer, so a break never wakes the slow local model.
- **The side-panel chat input stays disabled**, with the reason in the header.
- Every open tab reacts live through `chrome.storage.onChanged`.

Resume is a small **"Parent: resume session"** control at the bottom of the side
panel (a muted link that grows into a button while paused). It calls
`POST /resume` when LIVE mode is on, and clears the local flag either way, so it
works with no backend at all. It also resets the risk counter below, so the
demo can be replayed without reloading the extension.

"Ask my buddy" on the block interstitial asks the service worker to call
`chrome.sidePanel.open()`. Chrome only allows that while a user gesture is live
and the gesture does not always survive the message hop, so the worker pre-arms
the panel with `sidePanel.setOptions({tabId, enabled:true})` on every decision
and tab update, calls `open()` before any `await`, retries with `windowId`, and
on failure the page shows a "Click the KidGuard icon up here" card instead of
doing nothing.

A decision is re-run when the URL changes (`popstate`, `hashchange`, bfcache
restore and a 1 s href poll, all debounced), because a content script cannot see
`history.pushState` calls made in the page world.

## Backend contract (teammate A)

`background.js` calls, with a 20 s `AbortController` timeout:

**`POST http://127.0.0.1:8000/decide`**

```json
{ "url": "http://127.0.0.1:8765/demo_sites/phishing.html",
  "title": "Player Portal - verify your account",
  "text": "first 1500 chars of body.innerText",
  "age": 10 }
```

Response (canonical shape):

```json
{ "kid_message": "Stop! This page wants your password.",
  "tool_calls": [
    { "tool": "block_page", "args": { "reason": "...", "safer_alternative": "classroom.html" } },
    { "tool": "highlight_element", "args": { "text_or_css": "#password", "message": "Never type your password here." } },
    { "tool": "move_mascot", "args": { "x_hint": "center", "mood": "worry" } },
    { "tool": "notify_parent", "args": { "summary": "Blocked a fake login page" } }
  ] }
```

**`POST /coach`** with `{ "message": "can I go to classroom?" }` returns
`{ "reply": "...", "tool_calls": [...] }` (`kid_message` is also accepted as the
reply field).

**`POST /notify`** (optional) with `{ "summary": "...", "url": "..." }` - used
when the extension executes `notify_parent` client-side. A missing route is
harmless. `pause_session` also goes through it, as
`{"summary": "Session paused. <reason>"}`, so the pause and its reason show up
in the parent feed.

**`POST /resume`** (LIVE mode only) with an empty body - sent by the side
panel's "Parent: resume session" control. The extension clears its own paused
flag whether or not the call succeeds, so MOCK mode needs no backend.

**`GET /events`** returns the array consumed by `frontend/parent.html`; each
item may use `ts`/`time`/`timestamp`, `action`/`tool`,
`summary`/`message`/`detail`, and `url`.

The normalizer in `background.js` is deliberately forgiving: tool calls may
arrive as `tool_calls`, `actions`, `tools`, or a single flat `{action, ...}`
object; the tool name may be `tool`, `name`, `action`, or `function.name`; args
may be `args`, `arguments`, `params`, a JSON string, or flat on the object.
Unknown tool names are dropped with a console warning. Non-200 responses and
timeouts return `{ok: false, error: "backend_unreachable"}` and the UI shows a
toast - it never hangs.

CORS: the service worker's own requests are covered by `host_permissions`, so
no CORS headers are strictly required for the extension. `frontend/parent.html`
**does** need them (it is a normal page on port 8765 calling port 8000), so add
FastAPI's `CORSMiddleware` with `allow_origins=["*"]`.

### Checking the contract automatically

```powershell
.\scripts\check_contract.ps1          # bash scripts/check_contract.sh
.\scripts\check_contract.ps1 -Strict  # wrong classification also fails
```

It POSTs the four fixtures in `scripts/fixtures/*.json` to `/decide`, calls
`/coach`, reads `/events` with `Origin: http://127.0.0.1:8765`, and prints one
`[PASS]` / `[FAIL]` / `[WARN]` line per check, naming the offending field and
the fix. `[FAIL]` = the extension breaks; `[WARN]` = off-contract but the
normalizer or a UI fallback covers it. Exit codes: `0` pass, `1` contract
failure, `2` backend not running (friendly message, no stack trace), `3` a
fixture/setup problem. Edit the fixtures - not the script - to change the page
text sent to `/decide`. `pause_session` is part of its known-tool list and needs
a non-empty `args.reason`; anything outside the frozen contract is still a
`[FAIL]` because the extension drops it.

## Mascot seam (teammate C)

The placeholder mascot is a CSS blob that reacts to mood. Replace it without
touching `content.js`:

```js
// in a second content script listed AFTER content.js in manifest.json
const host = window.__KIDGUARD__.getMascotHost(); // <div id="kidguard-mascot-host">
// mount your Three.js canvas inside `host`
window.__KIDGUARD__.setMascotRendererReady();     // removes the placeholder blob

document.addEventListener('kidguard:mascot', (e) => {
  const { mood, x, y, targetRect } = e.detail;
  // mood       : 'idle' | 'worry' | 'happy' | 'point'
  // x, y       : viewport pixel coords the mascot should move to
  // targetRect : {top,left,width,height} of the highlighted element, or null
});
```

- The event fires on `document` for **every** `move_mascot` and
  `highlight_element`, and also on `allow_page`, `block_page`, and decision
  failure.
- `content.js` already sets `transform: translate(x, y)` on the host, so a
  renderer that fills the host follows the mascot for free.
- The host lives inside the shadow root of `#kidguard-root`
  (`z-index: 2147483000`, `pointer-events: none`). Set `pointer-events: auto`
  on your canvas if you need clicks.
- Also available in the same isolated world:
  `window.__KIDGUARD__.onMascot(cb)` (returns an unsubscribe function) and
  `window.__KIDGUARD__.getHighlightRect()`.
- MV3 forbids remote code: bundle Three.js as a local file in `extension/lib/`,
  no CDN `<script src="https://...">`.

All KidGuard UI lives inside that one shadow root, so page CSS cannot break it
and KidGuard CSS cannot leak into the page.

## 3D mascot — shipped (teammate C)

The seam above is now consumed by a real Three.js renderer. `content.js` was
**not** modified.

```text
extension/lib/three.min.js          three r137 (UMD, global THREE)
extension/lib/GLTFLoader.js         three r137 examples/js (global THREE.GLTFLoader)
extension/mascot/mascot-fallback.js procedural capybara built from primitives
extension/mascot/mascot-scene.js    renderer, camera, lights, GLB + AnimationMixer
extension/mascot/mascot-controller.js public API, positioning, speech bubble
extension/mascot/mascot-events.js   event bridge + bootstrap (loads last)
extension/mascot/mascot.css         bubble / minimise control (injected in the shadow root)
extension/mascot_preview.html       standalone iteration harness
```

Full documentation, including the copy-paste snippets and the manifest entries:
**[`extension/mascot/README.md`](extension/mascot/README.md)**. Model drop-in
instructions: **[`extension/assets/README.md`](extension/assets/README.md)**.

Quick control from anywhere in the page's isolated world:

```js
KidGuardMascot.setMood('happy');
KidGuardMascot.setMessage('This page looks fine!');
KidGuardMascot.pointToElement(document.querySelector('#password'), {
  message: 'Never type your password here.'
});
KidGuardMascot.reset();
```

Person B's `document`-level `kidguard:mascot` event stays the primary channel;
a `window`-level event and an `{action, message, targetRect:{x,y,w,h}}` payload
are also accepted and normalised. Unknown moods degrade to `idle`.

Three.js r137 was picked on purpose: from r150 the legacy non-module
`examples/js` builds are gone, and **content scripts cannot be ES modules**, so
r137 is the last comfortable version that gives both a global `THREE` and a
global `THREE.GLTFLoader` with no bundler in the loop.

### Iterating on the mascot without reloading the extension

```powershell
.\scripts\serve_demo.ps1
# then open
# http://127.0.0.1:8765/extension/mascot_preview.html
```

The harness stubs the whole seam (shadow root, `#kidguard-mascot-host`,
`window.__KIDGUARD__`, `chrome.runtime.getURL`), has one button per mood, a
draggable fake highlight target for `point`, the four demo scenarios, and shows
the live mood plus any load error on the page itself.

`extension/assets/mascot.glb` is **not** in the repo: until a teammate drops one
there, the procedural capybara is the character on screen.
