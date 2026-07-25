export const KIDGUARD_MASCOT_COMMAND_EVENT = "kidguard:mascot-command" as const;

export type MascotMood =
  | "idle"
  | "thinking"
  | "happy"
  | "worry"
  | "point"
  | "blocked";

export type TargetRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
};

export type MascotCorner =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export type MascotCommand =
  | { type: "SET_MOOD"; mood: MascotMood; message?: string }
  | { type: "POINT_TO_ELEMENT"; target: TargetRect; message?: string }
  | { type: "MOVE_TO_CORNER"; corner: MascotCorner }
  | { type: "SHOW" }
  | { type: "HIDE" }
  | { type: "RESET" };

export function emitMascotCommand(
  command: MascotCommand,
  target: EventTarget = window,
): boolean {
  return target.dispatchEvent(
    new CustomEvent<MascotCommand>(KIDGUARD_MASCOT_COMMAND_EVENT, {
      detail: command,
    }),
  );
}
