# Integration Status

- Owner: Person C.
- Active branch: `feature/person-c-mascot-ui`.
- Current phase: Phase 6 complete.
- Latest commit hash: `65e1038`.
- Build status: `npm.cmd run typecheck` passed; `npm.cmd run build` passed.
- Local preview command: `npm run dev -- --host 127.0.0.1 --port 5173`.
- Local preview URL: `http://127.0.0.1:5173/`.
- Production output path: `extension/mascot-ui/dist`.
- Completed pointing behavior: `POINT_TO_ELEMENT` calculates target center, chooses a non-overlapping corner, moves the mascot, points an arm and guide line toward the target, shows the optional message, and keeps target clicks/scrolling unblocked.
- Completed features: moods, show/hide/reset, corner movement, command validation, coaching bubble, local dev panel, deterministic build filenames.
- Incomplete features: content-script mounting, extension packaging, final mascot art, GLB, shaders, backend connection.
- Public contract status: `kidguard:mascot-command` event and command names are frozen for merge compatibility.
- RESET behavior: clears target, point message, pointing pose, and returns to idle/default corner.
- Remaining limitations: approximate visual pointing only; no GLB, shaders, Chrome APIs, backend calls, physics, or inverse kinematics.
- Next integration step: content script can dispatch validated `kidguard:mascot-command` events with real element rectangles.
- Integration guide: `extension/mascot-ui/INTEGRATE.md`.
- Current blockers: none for Person C handoff; extension-core wiring remains outside this package.
