import { useEffect, useRef, useState } from "react";
import type { MascotCommand } from "../contract/mascotCommands";
import {
  getWindowViewportBounds,
  subscribeToMascotCommands,
} from "../bridge/mascotEventBridge";
import {
  DEFAULT_MASCOT_MACHINE_STATE,
  resolveMascotViewState,
  transitionMascotState,
  type MascotMachineEffect,
  type MascotMachineState,
  type MascotViewState,
} from "../state/mascotStateMachine";

export type MascotState = MascotViewState;

export function useMascotCommands(eventTarget: EventTarget = window): MascotState {
  const [machineState, setMachineState] = useState<MascotMachineState>(
    DEFAULT_MASCOT_MACHINE_STATE,
  );
  const machineStateRef = useRef<MascotMachineState>(DEFAULT_MASCOT_MACHINE_STATE);
  const happyTimerRef = useRef<number | null>(null);

  const clearHappyTimer = (): void => {
    if (happyTimerRef.current !== null) {
      window.clearTimeout(happyTimerRef.current);
      happyTimerRef.current = null;
    }
  };

  useEffect(() => {
    const applyEffect = (effect: MascotMachineEffect): void => {
      if (effect.type === "CANCEL_HAPPY_TIMER") {
        clearHappyTimer();
        return;
      }

      if (effect.type === "SCHEDULE_HAPPY_RETURN") {
        clearHappyTimer();
        happyTimerRef.current = window.setTimeout(() => {
          happyTimerRef.current = null;
          const now = Date.now();
          const result = transitionMascotState(
            machineStateRef.current,
            { type: "HAPPY_ANIMATION_COMPLETE", now },
            now,
          );
          machineStateRef.current = result.state;
          setMachineState(result.state);
        }, effect.delayMs);
      }
    };

    const applyCommand = (command: MascotCommand): void => {
      const result = transitionMascotState(machineStateRef.current, command, Date.now());
      machineStateRef.current = result.state;
      setMachineState(result.state);
      applyEffect(result.effect);
    };

    const subscription = subscribeToMascotCommands(
      eventTarget,
      getWindowViewportBounds,
      applyCommand,
    );

    return () => {
      subscription.unsubscribe();
      clearHappyTimer();
    };
  }, [eventTarget]);

  return resolveMascotViewState(machineState);
}
