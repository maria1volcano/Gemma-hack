# Person C Team Change Log

## 2026-07-25 - Deterministic Mascot State Machine

- Added a pure TypeScript mascot state machine for `idle`, `thinking`,
  `happy`, `worry`, `point`, and `blocked`.
- Separated persistent mascot state from temporary animation state.
- Made `happy` return to `idle` after a short timer while allowing `blocked`
  to override it.
- Kept `point` active until the target disappears or another command arrives.
- Updated the command hook to cancel incompatible timers and clean timers on
  unmount.
- Kept the state machine testable outside React Three Fiber and the Canvas.
