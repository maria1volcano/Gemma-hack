# KidGuard Mascot UI Handoff

## Scope

Person C owns the isolated mascot frontend in `extension/mascot-ui`.

This package is a standalone React, TypeScript, Vite, Three.js, and
`@react-three/fiber` frontend. It does not depend on the content script,
backend, Chrome extension APIs, or Gemma runtime.

## Current Phase

Phase 2 prepares the mascot frontend for later integration and merge.

Implemented:

- Root `MascotOverlay` component.
- Fixed transparent overlay container.
- One transparent React Three Fiber `Canvas`.
- Procedural placeholder mascot using a sphere.
- Bottom-right positioning by default.
- Non-blocking overlay behavior with `pointer-events: none`.
- Pointer events enabled only for explicit KidGuard interactive controls.
- Strict TypeScript command contract for future content-script integration.
- Runtime command listener hook that validates malformed payloads and clamps
  target coordinates.
- Deterministic Vite build output for Manifest V3-local assets.

Not implemented yet:

- GLB mascot model loading.
- Custom shaders.
- Final mascot animations.
- Chrome extension API integration.
- Backend or Gemma API calls.
- Content script wiring.

## Build Output

Production build emits deterministic extension-local assets:

- `dist/index.html`
- `dist/assets/mascot.css`
- `dist/assets/mascot.js`

These paths are configured in `vite.config.ts` and are suitable for later
Manifest V3 integration.

## Event Contract

Event name:

```ts
kidguard:mascot-command
```

Exported constant:

```ts
KIDGUARD_MASCOT_COMMAND_EVENT
```

Command emitter:

```ts
emitMascotCommand(command)
```

Types:

```ts
type MascotMood =
  | "idle"
  | "thinking"
  | "happy"
  | "worry"
  | "point"
  | "blocked";

type TargetRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
};

type MascotCommand =
  | { type: "SET_MOOD"; mood: MascotMood }
  | { type: "POINT_TO_ELEMENT"; target: TargetRect }
  | { type: "MOVE_TO_CORNER"; corner: MascotCorner }
  | { type: "SHOW" }
  | { type: "HIDE" }
  | { type: "RESET" };
```

## Integration Notes

Later extension integration should dispatch `CustomEvent<MascotCommand>` on
`window` using the shared event name. The mascot frontend ignores malformed
commands and removes its event listener on unmount.

The current overlay is intentionally self-contained. Future content-script work
can mount the built assets or import the React entry without requiring backend
changes.

## Verification

Run from `extension/mascot-ui`:

```bash
npm run typecheck
npm run build
```

Last verified:

- TypeScript check passed.
- Production build passed.
- Vite reported a chunk-size warning for `assets/mascot.js`, expected because
  Three.js and React Three Fiber are bundled into one deterministic asset.
