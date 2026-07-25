import { lazy, Suspense } from "react";
import { MascotOverlay } from "./components/MascotOverlay";

const showCommandPanel =
  import.meta.env.DEV && import.meta.env.VITE_MASCOT_COMMAND_PANEL !== "false";

const MascotCommandPanel = showCommandPanel
  ? lazy(async () => {
      const module = await import("./components/MascotCommandPanel");
      return { default: module.MascotCommandPanel };
    })
  : null;

export function App(): React.JSX.Element {
  return (
    <>
      <MascotOverlay />
      {MascotCommandPanel ? (
        <Suspense fallback={null}>
          <MascotCommandPanel />
        </Suspense>
      ) : null}
    </>
  );
}
