import { Canvas } from "@react-three/fiber";
import type { CSSProperties } from "react";
import type { MascotCorner, TargetRect } from "../contract/mascotCommands";
import { useMascotCommands } from "../hooks/useMascotCommands";

const cornerClassName = {
  "top-left": "mascot-container--top-left",
  "top-right": "mascot-container--top-right",
  "bottom-left": "mascot-container--bottom-left",
  "bottom-right": "mascot-container--bottom-right",
} as const;

const MASCOT_DESKTOP_SIZE = { width: 132, height: 160 };
const MASCOT_MARGIN = 18;

const getMascotCenter = (
  corner: MascotCorner,
  target: TargetRect | null,
): { x: number; y: number } | null => {
  if (!target) {
    return null;
  }

  const centerOffsetX = MASCOT_DESKTOP_SIZE.width / 2;
  const centerOffsetY = MASCOT_DESKTOP_SIZE.height / 2;

  switch (corner) {
    case "top-left":
      return { x: MASCOT_MARGIN + centerOffsetX, y: MASCOT_MARGIN + centerOffsetY };
    case "top-right":
      return {
        x: target.viewportWidth - MASCOT_MARGIN - centerOffsetX,
        y: MASCOT_MARGIN + centerOffsetY,
      };
    case "bottom-left":
      return {
        x: MASCOT_MARGIN + centerOffsetX,
        y: target.viewportHeight - MASCOT_MARGIN - centerOffsetY,
      };
    case "bottom-right":
      return {
        x: target.viewportWidth - MASCOT_MARGIN - centerOffsetX,
        y: target.viewportHeight - MASCOT_MARGIN - centerOffsetY,
      };
  }
};

function PlaceholderMascot({ pointAngle }: { pointAngle: number | null }): React.JSX.Element {
  const armRotation = pointAngle === null ? -0.7 : Math.PI / 2 - pointAngle;

  return (
    <group rotation={[0.25, pointAngle === null ? 0.35 : 0, 0]}>
      <mesh>
        <sphereGeometry args={[0.9, 32, 32]} />
        <meshStandardMaterial color="#32d3a2" roughness={0.45} metalness={0.08} />
      </mesh>
      <group rotation={[0, 0, armRotation]} position={[0, 0.08, 0]}>
        <mesh position={[0, 0.82, 0]}>
          <cylinderGeometry args={[0.08, 0.11, 1.45, 16]} />
          <meshStandardMaterial color="#18a77d" roughness={0.5} />
        </mesh>
        <mesh position={[0, 1.58, 0]}>
          <sphereGeometry args={[0.16, 16, 16]} />
          <meshStandardMaterial color="#0f7f62" roughness={0.45} />
        </mesh>
      </group>
    </group>
  );
}

export function MascotOverlay(): React.JSX.Element {
  const mascot = useMascotCommands();

  const targetStyle: CSSProperties | undefined = mascot.target
    ? {
        left: `${mascot.target.x}px`,
        top: `${mascot.target.y}px`,
        width: `${mascot.target.width}px`,
        height: `${mascot.target.height}px`,
      }
    : undefined;
  const targetCenter = mascot.target
    ? {
        x: mascot.target.x + mascot.target.width / 2,
        y: mascot.target.y + mascot.target.height / 2,
      }
    : null;
  const mascotCenter = getMascotCenter(mascot.corner, mascot.target);
  const pointAngle =
    mascotCenter && targetCenter
      ? Math.atan2(targetCenter.y - mascotCenter.y, targetCenter.x - mascotCenter.x)
      : null;
  const guideStyle: CSSProperties | undefined =
    mascotCenter && targetCenter && pointAngle !== null
      ? {
          left: `${mascotCenter.x}px`,
          top: `${mascotCenter.y}px`,
          width: `${Math.hypot(targetCenter.x - mascotCenter.x, targetCenter.y - mascotCenter.y)}px`,
          transform: `rotate(${pointAngle}rad)`,
        }
      : undefined;

  return (
    <div className="kidguard-overlay" aria-hidden={!mascot.visible}>
      {mascot.target ? <div className="mascot-target-outline" style={targetStyle} /> : null}
      {guideStyle ? <div className="mascot-point-guide" style={guideStyle} /> : null}
      <div
        className={`mascot-container ${cornerClassName[mascot.corner]} ${
          mascot.visible ? "is-visible" : "is-hidden"
        }`}
        data-mood={mascot.mood}
      >
        <Canvas
          gl={{ alpha: true, antialias: true }}
          camera={{ position: [0, 0, 4], fov: 45 }}
          className="mascot-canvas"
        >
          <ambientLight intensity={1.2} />
          <directionalLight position={[3, 4, 5]} intensity={1.8} />
          <PlaceholderMascot pointAngle={pointAngle} />
        </Canvas>
        <div className="mascot-status" aria-hidden="true">
          {mascot.coachingMessage ?? mascot.mood}
        </div>
      </div>
    </div>
  );
}
