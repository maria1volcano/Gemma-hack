# KidGuard 3D mascot (teammate C)

A floating 3D capybara that reacts to the agent's decisions and points at
whatever the extension highlights. It plugs into Person B's existing seam in
`extension/content.js` **without modifying it**.

---

## 1. Files and load order

Content scripts cannot be ES modules, so everything is a classic script sharing
one namespaced global (`window.KidGuardMascotNS`). Order matters:

```text
lib/three.min.js            three r137, UMD -> global THREE
lib/GLTFLoader.js           three r137 examples/js -> global THREE.GLTFLoader
mascot/mascot-fallback.js   procedural capybara built from primitives
mascot/mascot-scene.js      renderer, camera, lights, GLB loading, mixer, moods
mascot/mascot-controller.js public API, positioning, speech bubble, lifecycle
mascot/mascot-events.js     event bridge + bootstrap (must be last)
mascot/mascot.css           injected as a <link> into the shadow root
```

`mascot-events.js` boots itself: it waits for `window.__KIDGUARD__`, builds the
controller, calls `setMascotRendererReady()` after the first rendered frame
(so the CSS placeholder blob disappears only once 3D is really up), and
publishes `window.KidGuardMascot`.

### Required manifest entries

```jsonc
"content_scripts": [{
  "js": [
    "content.js",
    "lib/three.min.js",
    "lib/GLTFLoader.js",
    "mascot/mascot-fallback.js",
    "mascot/mascot-scene.js",
    "mascot/mascot-controller.js",
    "mascot/mascot-events.js"
  ]
}],
"web_accessible_resources": [{
  "resources": ["lib/*", "assets/*", "mascot/*", "overlay.css"]
}]
```

`mascot/*` must be web accessible because `mascot.css` is loaded by URL, and
`assets/*` because the GLB is fetched with `chrome.runtime.getURL`.

---

## 2. Public API — `window.KidGuardMascot`

Available immediately; calls made before the renderer is up are queued and
replayed. `window.__KIDGUARD__` is untouched and keeps working.

```js
KidGuardMascot.show();                    // un-hide / un-minimise
KidGuardMascot.hide();                    // remove from view, pauses the render loop
KidGuardMascot.setMood('idle');           // slow breathing, blinks, gentle sway
KidGuardMascot.setMood('worry');          // leans back, head shake, cool tint, calm pulse
KidGuardMascot.setMood('happy');          // bounce, swivel, sparkles, back to idle after ~3 s
KidGuardMascot.setMood('point');          // pointing pose (aim it with pointTo*)
KidGuardMascot.setMessage('Careful here!');       // speech bubble, auto-dismiss ~5 s
KidGuardMascot.setMessage('Stays put', 0);        // 0 = no auto-dismiss
KidGuardMascot.pointToElement(document.querySelector('#password'), {
  message: 'Never type your password here.',
  returnAfter: 8000                        // ms before going back to idle (default 6000)
});
KidGuardMascot.pointToCoordinates(640, 320);      // viewport pixels
KidGuardMascot.setMinimised(true);        // same as clicking the minimise dot
KidGuardMascot.reset();                   // idle, no target, no message, visible
KidGuardMascot.destroy();                 // dispose GPU resources + remove listeners

KidGuardMascot.getMood();                 // 'idle' | 'worry' | 'happy' | 'point'
KidGuardMascot.state;                     // { mood, ready, usingGlb, procedural, error, ... }
KidGuardMascot.onStatus(s => console.log(s));
```

### Behaviour when the target is missing

`pointToElement(null)`, `pointToElement(<detached element>)` or an event with
`targetRect: null` never throws and never hides the mascot: it falls back to
the pointing pose aimed straight ahead (and to `idle` when the caller asks for
`fallbackMood: 'idle'`). A target that is scrolled **off-screen** is kept, so
the mascot points in its direction instead of vanishing with it.

---

## 3. Events consumed (Person B's channel is primary)

```js
// what content.js already does - fully supported, nothing to change
document.dispatchEvent(new CustomEvent('kidguard:mascot', {
  detail: { mood: 'point', x: 900, y: 500, targetRect: { top, left, width, height } }
}));
// also supported: window.__KIDGUARD__.onMascot(cb)
```

Additionally tolerated so another producer also works:

```js
window.dispatchEvent(new CustomEvent('kidguard:mascot', {
  detail: {
    action: 'highlight_element',            // allow_page|warn_kid|block_page|highlight_element|...
    mood: 'point',                          // optional when `action` is given
    message: 'Look here',                   // optional -> speech bubble
    targetRect: { x, y, width, height }     // x/y accepted as aliases of left/top
  }
}));
```

Normalisation rules: `mood` wins over `action`; an unknown mood falls back to
`idle` (or to `point` when a rect is present); `{x,y,width,height}` and
`{top,left,width,height}` are both accepted; duplicates arriving within 80 ms
through several channels are collapsed.

Action → mood mapping: `allow_page|allow|safe|ok → happy`,
`warn_kid|warn|caution|suspicious|block_page|block|danger → worry`,
`highlight_element|highlight|point|look → point`, `idle|reset → idle`.

---

## 4. Who owns the position

`content.js` already sets `transform: translate(x, y)` on
`#kidguard-mascot-host`. To avoid two owners fighting:

- **content.js keeps owning the base position.** Nothing in `mascot/*` ever
  writes to `host.style.transform`.
- The renderer mounts a `.kgm-stage` wrapper **inside** the host and owns only a
  bounded local offset on that wrapper (max ±130 px horizontally, ±80 px
  vertically), plus the 3D orientation/lean. The two transforms compose.
- That offset is clamped to keep the mascot inside the viewport and is pushed
  aside when it would cover the highlighted element. The speech bubble lives in
  a sibling full-viewport layer and avoids the highlighted rect too.

---

## 5. The character

`assets/mascot.glb` is loaded if present, otherwise the procedural capybara in
`mascot-fallback.js` is the character (no console error either way — the file is
probed with `fetch` before the loader touches it). See `../assets/README.md`
for the exact scale/orientation the loader expects.

Clip names are matched case-insensitively and loosely
(`idle|breath|stand|rest`, `happy|wave|celebrat|jump|cheer`,
`worry|fear|concern|sad|scare`, `point|gesture|look|aim`), crossfaded over
280 ms, and an already-playing clip is never restarted. Missing clips simply
fall back to the procedural motion.

---

## 6. Performance / accessibility

- One renderer, one character per page; `setPixelRatio(min(dpr, 1.5))`.
- The rAF loop stops on `document.hidden` and when the canvas leaves the
  viewport (`IntersectionObserver`), and while hidden/minimised.
- Scroll and resize are rAF-throttled; one `getBoundingClientRect()` per frame
  at most; geometries and materials are shared and disposed on `destroy()`.
- `prefers-reduced-motion: reduce` removes the entrance pop, the bounce and the
  CSS transitions, keeps the poses, and repositions instantly.
- The overlay and the canvas are `pointer-events: none`; only the minimise dot
  and the bubble's close button accept clicks.
- The worry pulse cycles at ~0.3 Hz (no flashing).

---

## 7. Local iteration without Chrome

```powershell
.\scripts\serve_demo.ps1     # or: python -m http.server 8765
```

then open <http://127.0.0.1:8765/extension/mascot_preview.html>. The harness
stubs the seam (shadow root + `#kidguard-mascot-host` + `window.__KIDGUARD__` +
`chrome.runtime.getURL`), fires the real event for each mood, has a draggable
fake highlight target, the four demo scenarios, and prints the current mood,
the active character and any load error on the page itself.

> The extension's `content_scripts` also match `http://127.0.0.1:8765/*`, so if
> KidGuard is loaded in the same browser you get two mascots on the preview
> page (the harness's own, plus the injected one). Disable the extension while
> iterating, or open `mascot_preview.html` straight from disk. Adding
> `mascot_preview.html` to the manifest's `exclude_matches` would also fix it,
> but that file belongs to Person B.
