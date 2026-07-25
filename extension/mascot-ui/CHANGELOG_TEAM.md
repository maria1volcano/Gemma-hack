# Person C Change Log

## 2026-07-25 - Phase 5 Target Pointing

- `POINT_TO_ELEMENT` now moves the mascot to the farthest corner from the target.
- The mascot shows a simple pointing arm pose and guide line toward the target.
- The target outline and guide line use `pointer-events: none`, keeping the page target clickable.
- `RESET` clears the target through the existing state machine and returns to idle/default corner.
