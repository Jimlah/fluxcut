import {
  SkipBack,
  SkipForward,
  Flag,
  Star,
  Clock3,
  Ratio,
  SlidersHorizontal,
  LayoutGrid,
  WandSparkles,
  PanelRightOpen,
  LoaderCircle,
} from "lucide-react";
import { useFluxcutActions, useFluxcutStatus, useFluxcutSelector, useFluxcutView } from "../lib/useFluxcut";

/** Transport, state pills and the primary convert/cancel action. */
export default function BottomBar() {
  const actions = useFluxcutActions();

  const converting = useFluxcutStatus() === "converting";
  const hasFile = useFluxcutSelector((s) => !!s.context.fileUrl);
  const panelOpen = useFluxcutSelector((s) => s.context.panelOpen);
  const gridOn = useFluxcutSelector((s) => s.context.gridOn);
  const trimStart = useFluxcutSelector((s) => s.context.trim.start);
  const trimEnd = useFluxcutSelector((s) => s.context.trim.end);

  // State pills — pre-formatted by the machine layer's view model
  const { aspect, resLabel, durationText, qualityTag, sizeHint } = useFluxcutView();

  return (
    <div className="bottombar">
      <div className="transport">
        <button
          className="circle-btn"
          title="To trim start"
          onClick={() => actions.seek(trimStart || 0)}
          disabled={!hasFile}
        >
          <SkipBack />
        </button>
        <button
          className="circle-btn"
          title="Set In point"
          onClick={() => actions.setIn()}
          disabled={!hasFile}
        >
          <Flag />
        </button>
        <button
          className="circle-btn"
          title="Set Out point"
          onClick={() => actions.setOut()}
          disabled={!hasFile}
        >
          <Flag style={{ transform: "scaleX(-1)" }} />
        </button>
        <button
          className="circle-btn"
          title="To trim end"
          onClick={() => actions.seek(trimEnd || 0)}
          disabled={!hasFile}
        >
          <SkipForward />
        </button>
      </div>

      <div className="center">
        <span className="pill keep">
          <Ratio /> {aspect}
        </span>
        <span className="pill keep">
          <Star /> {resLabel}
        </span>
        <span className="pill keep">
          <Clock3 /> {durationText}
        </span>
        <span className="pill keep">
          <SlidersHorizontal /> {qualityTag}
          {sizeHint}
        </span>
      </div>

      <div className="right">
        <button
          className={`circle-btn${gridOn ? " active" : ""}`}
          title="Toggle grid"
          onClick={() => actions.toggleGrid()}
        >
          <LayoutGrid />
        </button>
        {converting ? (
          <button
            className="circle-btn primary"
            title="Cancel conversion"
            onClick={() => actions.cancel()}
          >
            <LoaderCircle style={{ animation: "spin 1s linear infinite" }} />
          </button>
        ) : panelOpen ? (
          <button
            className="circle-btn primary"
            title={hasFile ? "Convert" : "Choose a video"}
            onClick={() => {
              if (!hasFile) actions.pickFile();
              else actions.convert();
            }}
          >
            <WandSparkles />
          </button>
        ) : (
          // Panel is closed — the primary button brings it back
          <button
            className="circle-btn primary"
            title="Open panel"
            onClick={() => actions.setPanelOpen(true)}
          >
            <PanelRightOpen />
          </button>
        )}
      </div>
    </div>
  );
}
