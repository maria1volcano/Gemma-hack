import type {
  MascotCommand,
  MascotCorner,
  MascotMood,
  TargetRect,
} from "../contract/mascotCommands";

export const HAPPY_ANIMATION_MS = 1_200;

export type DurableMascotMood = Exclude<MascotMood, "happy" | "point">;

export type MascotPersistentState = {
  mood: DurableMascotMood;
  visible: boolean;
  corner: MascotCorner;
  target: TargetRect | null;
  pointMessage: string | null;
};

export type MascotAnimationState = {
  happyUntil: number | null;
};

export type MascotMachineState = {
  persistent: MascotPersistentState;
  animation: MascotAnimationState;
};

export type MascotViewState = {
  mood: MascotMood;
  visible: boolean;
  corner: MascotCorner;
  target: TargetRect | null;
  pointMessage: string | null;
};

export type MascotMachineEffect =
  | { type: "NONE" }
  | { type: "CANCEL_HAPPY_TIMER" }
  | { type: "SCHEDULE_HAPPY_RETURN"; delayMs: number };

export type MascotInternalEvent =
  | { type: "HAPPY_ANIMATION_COMPLETE"; now: number }
  | { type: "TARGET_DISAPPEARED" };

export type MascotTransitionInput = MascotCommand | MascotInternalEvent;

export type MascotTransitionResult = {
  state: MascotMachineState;
  effect: MascotMachineEffect;
};

const DEFAULT_PERSISTENT_STATE: MascotPersistentState = {
  mood: "idle",
  visible: true,
  corner: "bottom-right",
  target: null,
  pointMessage: null,
};

export const DEFAULT_MASCOT_MACHINE_STATE: MascotMachineState = {
  persistent: DEFAULT_PERSISTENT_STATE,
  animation: {
    happyUntil: null,
  },
};

const clearHappyAnimation = (state: MascotMachineState): MascotMachineState => ({
  ...state,
  animation: {
    happyUntil: null,
  },
});

const isDurableMood = (mood: MascotMood): mood is DurableMascotMood =>
  mood !== "happy" && mood !== "point";

const withNoEffect = (state: MascotMachineState): MascotTransitionResult => ({
  state,
  effect: { type: "NONE" },
});

const choosePointingCorner = (target: TargetRect): MascotCorner => {
  const targetCenterX = target.x + target.width / 2;
  const targetCenterY = target.y + target.height / 2;
  const margin = 84;
  const corners: Array<{ corner: MascotCorner; x: number; y: number }> = [
    { corner: "top-left", x: margin, y: margin },
    { corner: "top-right", x: target.viewportWidth - margin, y: margin },
    { corner: "bottom-left", x: margin, y: target.viewportHeight - margin },
    {
      corner: "bottom-right",
      x: target.viewportWidth - margin,
      y: target.viewportHeight - margin,
    },
  ];

  return corners.reduce((best, candidate) => {
    const bestDistance =
      (best.x - targetCenterX) ** 2 + (best.y - targetCenterY) ** 2;
    const candidateDistance =
      (candidate.x - targetCenterX) ** 2 + (candidate.y - targetCenterY) ** 2;

    return candidateDistance > bestDistance ? candidate : best;
  }).corner;
};

export function resolveMascotViewState(state: MascotMachineState): MascotViewState {
  if (state.persistent.mood === "blocked") {
    return { ...state.persistent, mood: "blocked" };
  }

  if (state.persistent.target) {
    return { ...state.persistent, mood: "point" };
  }

  if (state.animation.happyUntil !== null) {
    return { ...state.persistent, mood: "happy" };
  }

  return { ...state.persistent, mood: state.persistent.mood };
}

export function transitionMascotState(
  state: MascotMachineState,
  input: MascotTransitionInput,
  now: number,
): MascotTransitionResult {
  switch (input.type) {
    case "SET_MOOD": {
      if (input.mood === "happy") {
        if (state.persistent.mood === "blocked") {
          return {
            state: clearHappyAnimation(state),
            effect: { type: "CANCEL_HAPPY_TIMER" },
          };
        }

        return {
          state: {
            persistent: {
              ...state.persistent,
              mood: "idle",
              target: null,
              pointMessage: null,
            },
            animation: {
              happyUntil: now + HAPPY_ANIMATION_MS,
            },
          },
          effect: { type: "SCHEDULE_HAPPY_RETURN", delayMs: HAPPY_ANIMATION_MS },
        };
      }

      if (input.mood === "point") {
        return withNoEffect(state);
      }

      if (!isDurableMood(input.mood)) {
        return withNoEffect(state);
      }

      return {
        state: {
          persistent: {
            ...state.persistent,
            mood: input.mood,
            target: null,
            pointMessage: null,
          },
          animation: {
            happyUntil: null,
          },
        },
        effect: { type: "CANCEL_HAPPY_TIMER" },
      };
    }
    case "POINT_TO_ELEMENT":
      return {
        state: {
          persistent: {
            ...state.persistent,
            corner: choosePointingCorner(input.target),
            visible: true,
            target: input.target,
            pointMessage: input.message ?? "Look here",
          },
          animation: {
            happyUntil: null,
          },
        },
        effect: { type: "CANCEL_HAPPY_TIMER" },
      };
    case "MOVE_TO_CORNER":
      return withNoEffect({
        ...state,
        persistent: {
          ...state.persistent,
          corner: input.corner,
          target: null,
          pointMessage: null,
        },
      });
    case "SHOW":
      return withNoEffect({
        ...state,
        persistent: {
          ...state.persistent,
          visible: true,
          target: null,
          pointMessage: null,
        },
      });
    case "HIDE":
      return withNoEffect({
        ...state,
        persistent: {
          ...state.persistent,
          visible: false,
          target: null,
          pointMessage: null,
        },
      });
    case "RESET":
      return {
        state: DEFAULT_MASCOT_MACHINE_STATE,
        effect: { type: "CANCEL_HAPPY_TIMER" },
      };
    case "HAPPY_ANIMATION_COMPLETE":
      if (state.animation.happyUntil === null || input.now < state.animation.happyUntil) {
        return withNoEffect(state);
      }

      return withNoEffect({
        ...state,
        persistent: {
          ...state.persistent,
          mood: state.persistent.mood === "blocked" ? "blocked" : "idle",
        },
        animation: {
          happyUntil: null,
        },
      });
    case "TARGET_DISAPPEARED":
      return withNoEffect({
        ...state,
        persistent: {
          ...state.persistent,
          target: null,
          pointMessage: null,
        },
      });
  }
}
