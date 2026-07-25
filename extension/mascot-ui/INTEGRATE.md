# KidGuard Mascot UI - Integration Guide

## Ownership

Person C owns:

- `extension/mascot-ui/**`
- mascot rendering
- React Three Fiber Canvas
- mascot state machine
- mascot command validation
- corner movement
- target pointing
- coaching bubble
- local mascot development harness

Person C does not own:

- `backend/**`
- Gemma prompts
- tool selection
- `extension/background.js`
- `extension/content.js`
- `extension/manifest.json`
- page scraping
- DOM highlight implementation
- parent event feed
- Chrome permissions

## Current Status

Currently works:

- standalone local preview
- procedural placeholder mascot
- moods: `idle`, `thinking`, `happy`, `worry`, `point`, `blocked`
- corner movement
- `POINT_TO_ELEMENT` target pointing
- `SHOW`, `HIDE`, and `RESET`
- coaching bubble for command messages
- local development controls in Vite dev mode
- production build

Extension integration is not complete yet.

## Public Event Contract

Event name, command names, and mood names are frozen for merge compatibility.

Event name:

```text
kidguard:mascot-command
```

Supported commands:

- `SET_MOOD`
- `POINT_TO_ELEMENT`
- `MOVE_TO_CORNER`
- `SHOW`
- `HIDE`
- `RESET`

Supported moods:

- `idle`
- `thinking`
- `happy`
- `worry`
- `point`
- `blocked`

`TargetRect` fields:

- `x`
- `y`
- `width`
- `height`
- `viewportWidth`
- `viewportHeight`

Optional message:

- `message?: string`
- accepted on `SET_MOOD` and `POINT_TO_ELEMENT`
- sanitized and capped before display

## Responsibilities By Teammate

### Person A - Gemma/backend

Person A provides:

- selected tool name
- tool arguments
- kid-facing message
- stable tool names

Person A must not control Three.js directly.

### Person B - extension core

Person B must:

1. create or inject the mascot host element
2. load or mount the mascot production bundle
3. calculate target coordinates using `getBoundingClientRect()`
4. dispatch `kidguard:mascot-command`
5. keep DOM selection and page highlighting outside `mascot-ui`
6. forward Gemma tool results
7. reset or remove the mascot when the extension stops

### Person C - mascot UI

Person C provides:

- compiled mascot bundle
- event listener
- command validation
- mood rendering
- corner movement
- pointing behavior
- coaching bubble
- fallback behavior

## Tool-To-Mascot Mapping

- `allow_page()` -> `SET_MOOD happy`
- `warn_kid(message, reason)` -> `SET_MOOD worry`
- `block_page(reason, safer_alternative)` -> `SET_MOOD blocked`
- `highlight_element(text_or_css, message)` -> `POINT_TO_ELEMENT`
- `move_mascot(x_hint, mood)` -> `MOVE_TO_CORNER` and/or `SET_MOOD`
- `suggest_alternative(label, url)` -> `POINT_TO_ELEMENT` or `happy`
- page analysis in progress -> `SET_MOOD thinking`

## Copy-Paste Examples

### SET_MOOD

```js
window.dispatchEvent(
  new CustomEvent("kidguard:mascot-command", {
    detail: {
      type: "SET_MOOD",
      mood: "worry",
      message: "This page may not be safe.",
    },
  }),
);
```

### POINT_TO_ELEMENT

```js
const element = document.querySelector("#safe-option");

if (element) {
  const rect = element.getBoundingClientRect();

  window.dispatchEvent(
    new CustomEvent("kidguard:mascot-command", {
      detail: {
        type: "POINT_TO_ELEMENT",
        target: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        },
        message: "Try this safer option.",
      },
    }),
  );
}
```

### MOVE_TO_CORNER

```js
window.dispatchEvent(
  new CustomEvent("kidguard:mascot-command", {
    detail: {
      type: "MOVE_TO_CORNER",
      corner: "bottom-right",
    },
  }),
);
```

### RESET

```js
window.dispatchEvent(
  new CustomEvent("kidguard:mascot-command", {
    detail: {
      type: "RESET",
    },
  }),
);
```

## Build Instructions

Real commands from `package.json`:

```bash
cd extension/mascot-ui
npm install
npm run dev
npm run build
```

Production output:

- output directory: `extension/mascot-ui/dist`
- JavaScript: `dist/assets/mascot.js`
- CSS: `dist/assets/mascot.css`
- filename hashing: disabled for JS/CSS entry assets
- `index.html`: generated and useful for standalone preview; extension-core may not need it if mounting the bundle manually
- assets: local extension files only
- build paths: Vite default absolute paths from `/assets/...` in `dist/index.html`; Person B should load extension files with `chrome.runtime.getURL(...)` during final wiring if needed

## Integration Entry Point

- React bootstrap entry file: `src/main.tsx`
- expected root element: `<div id="root"></div>`
- overlay behavior: `MascotOverlay` renders a fixed viewport overlay with `pointer-events: none`
- Shadow DOM: optional, not currently required or implemented
- production build shape: standalone Vite page plus deterministic JS/CSS assets
- limitation: the bundle does not currently expose a custom mount function; Person B still needs integration wiring to create a host/root and load or adapt the React entry in the real extension

## Loading Strategy Recommendation

Smallest safe integration recommendation:

1. Build with `npm run build`.
2. Add `dist/assets/mascot.js` and `dist/assets/mascot.css` as extension-local files.
3. Inject a host div with child `<div id="root"></div>` or adapt `src/main.tsx` in a separate integration commit.
4. Load CSS and JS from extension-local URLs, using `chrome.runtime.getURL(...)` from extension-core code if needed.
5. Dispatch `kidguard:mascot-command` events from content-script logic.

This loading strategy is a recommendation, not implemented in `extension/content.js` yet.

## Smoke-Test Checklist

- mascot bundle loads
- `SET_MOOD` works
- `POINT_TO_ELEMENT` works
- target remains clickable
- mascot relocates away from target
- `RESET` works
- page remains scrollable
- `SHOW`/`HIDE` works
- no backend is required for standalone preview
- no remote assets are required

## Conflict-Prone Files

Person C deliberately did not edit:

- `extension/manifest.json`
- `extension/content.js`
- `extension/background.js`
- root README
- root dependency files
- `backend/**`

Manual extension integration should happen in a separate integration commit.

## Known Limitations

- placeholder mascot visuals
- no final Japanese-inspired mascot
- no GLB
- no ShaderGradient
- no Liquid Logo material
- no final content-script mounting
- no direct backend connection
- no final extension packaging
- current production bundle is large because Three.js and React Three Fiber are bundled into `mascot.js`
- production build is a standalone page unless Person B performs extra extension wiring

## Recommended Merge Order

1. merge backend/Gemma branch
2. merge extension-core branch
3. merge `feature/person-c-mascot-ui`
4. create a separate integration branch or integration commit
5. wire host, bundle loading, and events
6. run the full extension demo before merging to main
