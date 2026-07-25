import {
  KIDGUARD_MASCOT_COMMAND_EVENT,
  type MascotCommand,
  type MascotCorner,
  type MascotMood,
  type TargetRect,
} from "../contract/mascotCommands";

export type ViewportBounds = {
  width: number;
  height: number;
};

export type MascotCommandHandler = (command: MascotCommand) => void;

export type MascotBridgeSubscription = {
  unsubscribe: () => void;
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

const sanitizeMessage = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 80) : undefined;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const normalizeViewport = (viewport: ViewportBounds): ViewportBounds | null => {
  if (
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return null;
  }

  return viewport;
};

export const getWindowViewportBounds = (): ViewportBounds => ({
  width: window.innerWidth,
  height: window.innerHeight,
});

export function validateTargetRect(
  value: unknown,
  viewport: ViewportBounds,
): TargetRect | null {
  const safeViewport = normalizeViewport(viewport);
  if (!safeViewport || !isRecord(value)) {
    return null;
  }

  const { x, y, width, height } = value;
  if (
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isFiniteNumber(width) ||
    !isFiniteNumber(height)
  ) {
    return null;
  }

  const clampedWidth = clamp(width, 0, safeViewport.width);
  const clampedHeight = clamp(height, 0, safeViewport.height);

  return {
    x: clamp(x, 0, Math.max(0, safeViewport.width - clampedWidth)),
    y: clamp(y, 0, Math.max(0, safeViewport.height - clampedHeight)),
    width: clampedWidth,
    height: clampedHeight,
    viewportWidth: safeViewport.width,
    viewportHeight: safeViewport.height,
  };
}

export function validateMascotCommand(
  value: unknown,
  viewport: ViewportBounds,
): MascotCommand | null {
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }

  switch (value.type) {
    case "SET_MOOD":
      return isMascotMood(value.mood) ? { type: "SET_MOOD", mood: value.mood } : null;
    case "POINT_TO_ELEMENT": {
      const target = validateTargetRect(value.target, viewport);
      const message = sanitizeMessage(value.message);
      return target
        ? {
            type: "POINT_TO_ELEMENT",
            target,
            ...(message ? { message } : {}),
          }
        : null;
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
}

export function subscribeToMascotCommands(
  eventTarget: EventTarget,
  getViewportBounds: () => ViewportBounds,
  onCommand: MascotCommandHandler,
): MascotBridgeSubscription {
  const handleCommand = (event: Event): void => {
    if (!(event instanceof CustomEvent)) {
      return;
    }

    const command = validateMascotCommand(event.detail, getViewportBounds());
    if (!command) {
      return;
    }

    onCommand(command);
  };

  eventTarget.addEventListener(KIDGUARD_MASCOT_COMMAND_EVENT, handleCommand);

  return {
    unsubscribe: () => {
      eventTarget.removeEventListener(KIDGUARD_MASCOT_COMMAND_EVENT, handleCommand);
    },
  };
}
