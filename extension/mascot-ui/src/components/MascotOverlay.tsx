import { Canvas } from "@react-three/fiber";
import type { CSSProperties } from "react";
import { useMascotCommands } from "../hooks/useMascotCommands";

const cornerClassName = {
  "top-left": "mascot-container--top-left",
  "top-right": "mascot-container--top-right",
  "bottom-left": "mascot-container--bottom-left",
  "bottom-right": "mascot-container--bottom-right",
} as const;

function PlaceholderMascot(): React.JSX.Element {
  return (
    <mesh rotation={[0.35, 0.45, 0]}>
      <sphereGeometry args={[1, 32, 32]} />
      <meshStandardMaterial color="#32d3a2" roughness={0.45} metalness={0.08} />
    </mesh>
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

  return (
    <div className="kidguard-overlay" aria-hidden={!mascot.visible}>
      {mascot.target ? <div className="mascot-target-outline" style={targetStyle} /> : null}
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
          <PlaceholderMascot />
        </Canvas>
        <div className="mascot-status" aria-hidden="true">
          {mascot.mood}
        </div>
      </div>
    </div>
  );
}
