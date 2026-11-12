import { useCallback } from "react";
import { Film, Play } from "lucide-react";
import Rail from "./components/Rail";
import TopBar from "./components/TopBar";
import Timeline from "./components/Timeline";
import BottomBar from "./components/BottomBar";
import ConvertPanel from "./components/ConvertPanel";
import FilePicker from "./components/FilePicker";
import { FluxcutProvider, useFluxcutActions, useFluxcutBusy, useFluxcutSelector } from "./lib/useFluxcut";

// Hero video fetched from the internet (see README credits)
const HERO_VIDEO = "https://assets.mixkit.co/videos/26789/26789-720.mp4"; // golden particle nebula

export default function App() {
  return (
    <FluxcutProvider>
      <Studio />
    </FluxcutProvider>
  );
}

/** Composition shell — every widget pulls its own state from the machine. */
function Studio() {
  const actions = useFluxcutActions();

  const fileUrl = useFluxcutSelector((s) => s.context.fileUrl);
  const playing = useFluxcutSelector((s) => s.context.playing);
  const busy = useFluxcutBusy();
  const dragOver = useFluxcutSelector((s) => s.context.dragOver);
  const gridOn = useFluxcutSelector((s) => s.context.gridOn);

  // Hand the stage <video> element to the machine (React 19 ref cleanup)
  const attachVideo = useCallback(
    (el: HTMLVideoElement | null) => {
      if (el) actions.attachVideo(el);
      return () => actions.detachVideo();
    },
    [actions]
  );

  // Keyboard shortcuts live inside the machine (invoked keyboardActor).

  return (
    <div className="page">
      <div className={`app-window${dragOver ? " dragging" : ""}`}>
        {/* ===== stage ===== */}
        <div className="stage">
          {fileUrl ? (
            <video
              ref={attachVideo}
              className="stage-media"
              src={fileUrl}
              onClick={() => actions.togglePlay()}
              playsInline
            />
          ) : (
            <video className="stage-media" src={HERO_VIDEO} autoPlay loop muted playsInline />
          )}
          <div className="vignette" />

          {!fileUrl && (
            <div className="idle-hint">
              <h1>
                Convert any video.
                <br />
                <em>Right here.</em>
              </h1>
              <p>MP4 · WebM · MOV · MKV — resized, re-encoded and trimmed locally in your browser.</p>
              <span className="mini">
                <Film /> Drop a file anywhere, or use the panel →
              </span>
            </div>
          )}

          {fileUrl && !playing && !busy && (
            <button
              onClick={() => actions.togglePlay()}
              className="play-overlay"
              title="Play (space)"
            >
              <Play />
            </button>
          )}

          {gridOn && <div className="stage-grid" />}
        </div>

        {dragOver && <div className="drag-veil">Drop to load</div>}

        {/* ===== widgets (each pulls its own state from the machine) ===== */}
        <Rail />
        <TopBar />
        <Timeline />
        <BottomBar />
        <ConvertPanel />
        <FilePicker />
      </div>
    </div>
  );
}
