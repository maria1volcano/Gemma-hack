import { useEffect, useState } from "react";
import {
  KIDGUARD_MASCOT_COMMAND_EVENT,
  type MascotCommand,
  type MascotCorner,
  type MascotMood,
  type TargetRect,
} from "../contract/mascotCommands";

export type MascotState = {
  mood: MascotMood;
  visible: boolean;
  corner: MascotCorner;
  target: TargetRect | null;
};

const DEFAULT_STATE: MascotState = {
  mood: "idle",
  visible: true,
  corner: "bottom-right",
  target: null,
};

const MOODS = ["idle", "thinking", "happy", "worry", "point", "blocked"] as const;
const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isMascotMood = (value: unknown): value is MascotMood =>
  typeof value === "string" && MOODS.includes(value as MascotMood);

const isMascotCorner = (value: unknown): value is MascotCorner =>
  typeof value === "string" && CORNERS.includes(value as MascotCorner);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const validateTargetRect = (value: unknown): TargetRect | null => {
  if (!isRecord(value)) {
    return null;
  }

  const { x, y, width, height, viewportWidth, viewportHeight } = value;
  if (
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isFiniteNumber(width) ||
    !isFiniteNumber(height) ||
    !isFiniteNumber(viewportWidth) ||
    !isFiniteNumber(viewportHeight) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0
  ) {
    return null;
  }

  const clampedWidth = clamp(width, 0, viewportWidth);
  const clampedHeight = clamp(height, 0, viewportHeight);

  return {
    x: clamp(x, 0, Math.max(0, viewportWidth - clampedWidth)),
    y: clamp(y, 0, Math.max(0, viewportHeight - clampedHeight)),
    width: clampedWidth,
    height: clampedHeight,
    viewportWidth,
    viewportHeight,
  };
};

const validateCommand = (value: unknown): MascotCommand | null => {
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }

  switch (value.type) {
    case "SET_MOOD":
      return isMascotMood(value.mood) ? { type: "SET_MOOD", mood: value.mood } : null;
    case "POINT_TO_ELEMENT": {
      const target = validateTargetRect(value.target);
      return target ? { type: "POINT_TO_ELEMENT", target } : null;
    }
    case "MOVE_TO_CORNER":
      return isMascotCorner(value.corner)
        ? { type: "MOVE_TO_CORNER", corner: value.corner }
        : null;
    case "SHOW":
    case "HIDE":
    case "RESET":
      return { type: value.type };
    default:
      return null;
  }
};

const reduceCommand = (state: MascotState, command: MascotCommand): MascotState => {
  switch (command.type) {
    case "SET_MOOD":
      return { ...state, mood: command.mood };
    case "POINT_TO_ELEMENT":
      return { ...state, visible: true, mood: "point", target: command.target };
    case "MOVE_TO_CORNER":
      return { ...state, corner: command.corner, target: null };
    case "SHOW":
      return { ...state, visible: true };
    case "HIDE":
      return { ...state, visible: false };
    case "RESET":
      return DEFAULT_STATE;
  }
};

export function useMascotCommands(eventTarget: EventTarget = window): MascotState {
  const [state, setState] = useState<MascotState>(DEFAULT_STATE);

  useEffect(() => {
    const handleCommand = (event: Event): void => {
      if (!(event instanceof CustomEvent)) {
        return;
      }

      const command = validateCommand(event.detail);
      if (!command) {
        return;
      }

      setState((current) => reduceCommand(current, command));
    };

    eventTarget.addEventListener(KIDGUARD_MASCOT_COMMAND_EVENT, handleCommand);

    return () => {
      eventTarget.removeEventListener(KIDGUARD_MASCOT_COMMAND_EVENT, handleCommand);
    };
  }, [eventTarget]);

  return state;
}
