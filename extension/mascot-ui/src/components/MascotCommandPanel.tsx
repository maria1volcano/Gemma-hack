import {
  emitMascotCommand,
  type MascotCorner,
  type MascotMood,
  type TargetRect,
} from "../contract/mascotCommands";
import "./MascotCommandPanel.css";

const MOODS: MascotMood[] = ["idle", "thinking", "happy", "worry", "point", "blocked"];
const CORNERS: MascotCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

type QuadrantTarget = {
  label: string;
  xRatio: number;
  yRatio: number;
  message: string;
};

const QUADRANT_TARGETS: QuadrantTarget[] = [
  { label: "Top left", xRatio: 0.08, yRatio: 0.12, message: "Check this top-left item" },
  { label: "Top right", xRatio: 0.68, yRatio: 0.12, message: "Look at this top-right item" },
  { label: "Bottom left", xRatio: 0.08, yRatio: 0.68, message: "Review this bottom-left item" },
  { label: "Bottom right", xRatio: 0.68, yRatio: 0.68, message: "This bottom-right item needs attention" },
  { label: "Near mascot", xRatio: 0.78, yRatio: 0.72, message: "Nearby target test" },
];

const buildTargetRect = (target: QuadrantTarget): TargetRect => {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(220, viewportWidth * 0.24);
  const height = Math.min(130, viewportHeight * 0.18);

  return {
    x: viewportWidth * target.xRatio,
    y: viewportHeight * target.yRatio,
    width,
    height,
    viewportWidth,
    viewportHeight,
  };
};

export function MascotCommandPanel(): React.JSX.Element {
  return (
    <section
      className="mascot-command-panel"
      data-kidguard-interactive="true"
      aria-label="KidGuard mascot command panel"
    >
      <h2>KidGuard Mascot</h2>

      <div className="mascot-command-group" aria-label="Mood commands">
        {MOODS.map((mood) => (
          <button
            key={mood}
            type="button"
            onClick={() => emitMascotCommand({ type: "SET_MOOD", mood })}
          >
            {mood}
          </button>
        ))}
      </div>

      <div className="mascot-command-group" aria-label="Position commands">
        {CORNERS.map((corner) => (
          <button
            key={corner}
            type="button"
            onClick={() => emitMascotCommand({ type: "MOVE_TO_CORNER", corner })}
          >
            {corner}
          </button>
        ))}
      </div>

      <div className="mascot-command-group" aria-label="Point commands">
        {QUADRANT_TARGETS.map((target) => (
          <button
            key={target.label}
            type="button"
            onClick={() =>
              emitMascotCommand({
                type: "POINT_TO_ELEMENT",
                target: buildTargetRect(target),
                message: target.message,
              })
            }
          >
            Point {target.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            QUADRANT_TARGETS.forEach((target, index) => {
              window.setTimeout(() => {
                emitMascotCommand({
                  type: "POINT_TO_ELEMENT",
                  target: buildTargetRect(target),
                  message: `Rapid ${target.label}`,
                });
              }, index * 120);
            });
          }}
        >
          Rapid points
        </button>
      </div>

      <div className="mascot-command-group" aria-label="Visibility commands">
        <button type="button" onClick={() => emitMascotCommand({ type: "SHOW" })}>
          Show
        </button>
        <button type="button" onClick={() => emitMascotCommand({ type: "HIDE" })}>
          Hide
        </button>
        <button type="button" onClick={() => emitMascotCommand({ type: "RESET" })}>
          Reset
        </button>
      </div>
    </section>
  );
}
