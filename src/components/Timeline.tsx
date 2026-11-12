import { useCallback } from "react";
import { Clapperboard } from "lucide-react";
import { useFluxcutActions, useTimelineView } from "../lib/useFluxcut";

/**
 * Pure presentation: geometry, mode, tick labels and drag capture all come
 * from the machine layer (selectTimelineView + stripDragActor). The component
 * only reports pointer-down X and click percentages.
 */
export default function Timeline() {
  const actions = useFluxcutActions();
  const { mode, frames, ticks, timeText, playheadPct, trimActive, trimLeftPct, trimWidthPct, trimInPct, trimOutPct } = useTimelineView();

  const live = mode === "live";
  const demo = mode === "demo";

  // Hand the strip element to the machine (React 19 ref cleanup)
  const attachStrip = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) actions.attachStrip(el);
      return () => actions.detachStrip();
    },
    [actions]
  );

  const beginDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    actions.dragStrip(e.clientX);
  };

  return (
    <div className="timeline-dock">
      <div className="ruler">
        {live ? (
          ticks.map((label, i) => (
            <span key={i} style={{ display: "contents" }}>
              <span className="tick-label">{label}</span>
              {i < ticks.length - 1 && <span className="dots" />}
            </span>
          ))
        ) : (
          <>
            <span className="tick-label">0s</span>
            <span className="dots" />
          </>
        )}
      </div>

      <div
        className="strip"
        ref={attachStrip}
        onPointerDown={live ? beginDrag : undefined}
      >
        {frames.map((f, i) => (
          <div
            key={i}
            className={`frame${demo ? " demo" : ""}`}
            onClick={() =>
              demo ? actions.pickFile() : actions.stripSeek((i + 0.5) / frames.length)
            }
            style={{ backgroundImage: `url(${f})` }}
          />
        ))}

        {demo && (
          <div className="demo-chip">
            <Clapperboard />
            <span>Demo reel — drop your video to see it here</span>
          </div>
        )}

        {live && (
          <div className="strip-overlay">
            {trimActive && (
              <>
                <div
                  className="trim-region"
                  style={{ left: `${trimLeftPct}%`, width: `${trimWidthPct}%` }}
                />
                <div className="marker" style={{ left: `${trimInPct}%` }} />
                <div className="marker" style={{ left: `${trimOutPct}%` }} />
              </>
            )}
            <div className="playhead" style={{ left: `${playheadPct}%` }} onPointerDown={beginDrag}>
              <span className="knob">{timeText}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
