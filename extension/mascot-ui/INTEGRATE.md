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

- standalone local preview with `npm run dev -- --host 127.0.0.1 --port 5173`
- procedural placeholder mascot
- moods: `idle`, `thinking`, `happy`, `worry`, `point`, `blocked`
- corner movement
- `POINT_TO_ELEMENT` target pointing
- `SHOW`, `HIDE`, and `RESET`
- coaching bubble for command messages
- local development controls in Vite dev mode
- production build

Current production output:

- output directory: `extension/mascot-ui/dist`
- JavaScript: `dist/assets/mascot.js`
- CSS: `dist/assets/mascot.css`
- filenames are deterministic and unhashed

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
      message: "Look here before clicking.",
    },
  }),
);
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

## Merge Notes

- Use `dist/assets/mascot.js` and `dist/assets/mascot.css` from `npm run build`.
- Do not call Chrome APIs from R3F components.
- Do not dispatch unvalidated page values directly from untrusted page scripts.
- The bridge clamps target coordinates to the current viewport.
- Overlay, target outline, and guide line use `pointer-events: none` so the page remains clickable and scrollable.
