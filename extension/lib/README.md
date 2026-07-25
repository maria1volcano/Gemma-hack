# `extension/lib/` — mascot drop-in zone (teammate C)

Anything in `lib/` and `assets/` is declared in `manifest.json` under
`web_accessible_resources`, so it can be fetched from the demo pages with
`chrome.runtime.getURL('lib/your-file.js')`.

## How to plug the Three.js mascot in

Add your script as a second content script in `manifest.json` (same
`matches` as `content.js`, listed **after** it so `window.__KIDGUARD__`
exists), then:

```js
const host = window.__KIDGUARD__.getMascotHost(); // <div id="kidguard-mascot-host">
// mount your renderer/canvas inside `host`
window.__KIDGUARD__.setMascotRendererReady();     // removes the CSS placeholder blob

document.addEventListener('kidguard:mascot', (e) => {
  const { mood, x, y, targetRect } = e.detail;
  // mood: 'idle' | 'worry' | 'happy' | 'point'
  // x, y: viewport pixel coords to move to
  // targetRect: {top,left,width,height} of the highlighted element, or null
});
```

`content.js` already applies `transform: translate(x, y)` to the host element,
so a renderer that just fills the host follows the mascot position for free.
Set `pointer-events: auto` on your own canvas if it needs clicks — the host is
`pointer-events: none` by default.

Bundle Three.js as a local file here. MV3 forbids loading remote code, so no
CDN `<script src="https://...">`.

## Vendored (done)

| File | What it is |
|---|---|
| `three.min.js` | **three r137** official minified UMD build (`build/three.min.js`, ~605 KB). Loaded as a classic script it exposes the global `THREE`. |
| `GLTFLoader.js` | **three r137** `examples/js/loaders/GLTFLoader.js` (~101 KB), the legacy non-module flavour that registers the global `THREE.GLTFLoader`. |

Both come from `unpkg.com/three@0.137.5`. r137 is deliberate: from r150 the
`examples/js` non-module builds no longer exist, and MV3 content scripts cannot
be ES modules, so `import` is not an option here. r137 gives a global `THREE`
**and** a global `THREE.GLTFLoader` with no bundler.

Version-specific API notes (r137 has no `ColorManagement`):

- colour output is `renderer.outputEncoding = THREE.sRGBEncoding`
  (**not** `outputColorSpace` / `SRGBColorSpace`, which arrived in r152), and
  authored colours are converted with `Color.convertSRGBToLinear()`;
- `useLegacyLights` does not exist yet (`physicallyCorrectLights` is the r137
  flag, left at its default `false`);
- `CapsuleGeometry` does not exist yet — the mascot is built from spheres,
  cylinders, tori and circles only.

The renderer that consumes these lives in `../mascot/` — see
[`../mascot/README.md`](../mascot/README.md).
