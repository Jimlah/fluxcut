import { Fragment, useCallback } from "react";
import {
  ArrowDown,
  ArrowUp,
  Clapperboard,
  Image as ImageIcon,
  Plus,
  Type,
  X,
  AudioLines,
  type LucideIcon,
} from "lucide-react";
import { DEMO_THUMBS, useFluxcutActions, useFluxcutBusy, useFluxcutSelector, useTimelineView } from "../lib/useFluxcut";
import type { ClipView, LaneView } from "../lib/useFluxcut";
import { SPEED_PRESETS } from "../lib/timeline";
import type { ClipDragMode, TrackKind } from "../lib/timeline";

const KIND_ICON: Record<TrackKind, LucideIcon> = {
  video: Clapperboard,
  image: ImageIcon,
  text: Type,
  audio: AudioLines,
};

const KIND_LABEL: Record<TrackKind, string> = {
  video: "Video",
  image: "Image",
  text: "Text",
  audio: "Audio",
};

const KIND_ADD_TITLE: Record<TrackKind, string> = {
  video: "Pick a video for this track",
  image: "Pick an image for this track",
  text: "Add a text clip at the playhead",
  audio: "Pick an audio file for this track",
};

/**
 * Pure presentation: lanes, ticks and the drag geometry come from the machine
 * layer (selectTimelineView + drag actors). The component only reports pointer
 * positions and intent — every placement decision happens in lib/timeline.ts.
 * The live view is a two-column grid: headers in column 1, and ruler, tracks,
 * the add footer, and the trim/playhead overlay in column 2 — so every time
 * percentage shares the track column's x-origin.
 */
export default function Timeline() {
  const actions = useFluxcutActions();
  const busy = useFluxcutBusy();
  const view = useTimelineView();
  const activeTool = useFluxcutSelector((s) => s.context.activeTool);
  const razor = activeTool === "razor";

  // Hand the ruler to the machine for scrubbing (React 19 ref cleanup)
  const attachStrip = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) actions.attachStrip(el);
      return () => actions.detachStrip();
    },
    [actions]
  );

  const beginScrub = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    actions.dragStrip(e.clientX);
  };

  // Clip body/edge pointer-down → the machine owns the drag from here
  const beginClipDrag = (e: React.PointerEvent, clipId: string, mode: ClipDragMode) => {
    e.preventDefault();
    e.stopPropagation();
    const row = (e.currentTarget as HTMLElement).closest<HTMLElement>(".lane-track");
    if (!row) return;
    const rect = row.getBoundingClientRect();
    const time = Math.max(0, ((e.clientX - rect.left) / rect.width) * view.secondsVisible);
    actions.clipDragStart({
      clipId,
      mode,
      time,
      element: row as HTMLDivElement,
      seconds: view.secondsVisible,
    });
  };

  // Razor: pointer-down on a clip body cuts at the landed time instead of dragging.
  const beginClipCut = (e: React.PointerEvent, clipId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const row = (e.currentTarget as HTMLElement).closest<HTMLElement>(".lane-track");
    if (!row) return;
    const rect = row.getBoundingClientRect();
    const time = Math.max(0, ((e.clientX - rect.left) / rect.width) * view.secondsVisible);
    actions.cutClip(clipId, time);
  };

  const emptyLaneClick = (lane: LaneView, e: React.PointerEvent) => {
    // A clip drag stops propagation, so a live pointerdown here means empty track.
    if (e.defaultPrevented) return;
    if (lane.kind === "text") actions.addTextClip(lane.id);
    else if (lane.kind === "image") actions.pickTrackMedia(lane.id);
    else actions.selectClip(null);
  };

  if (view.mode === "demo") {
    return (
      <div className="timeline-dock">
        <div className="ruler">
          <span className="tick-label">0s</span>
          <span className="dots" />
        </div>
        <div className="strip">
          {DEMO_THUMBS.map((f, i) => (
            <div
              key={i}
              className="frame demo"
              onClick={() => actions.pickFile()}
              style={{ backgroundImage: `url(${f})` }}
            />
          ))}
          <div className="demo-chip">
            <Clapperboard />
            <span>Demo reel — drop your video to see it here</span>
          </div>
        </div>
      </div>
    );
  }

  const laneRows = view.lanes.length + 2;

  return (
    <div className={"timeline-dock" + (razor ? " razor-active" : "")}>
      <div className="lanes">
        <div className="lanes-inner">
          <div className="ruler" style={{ gridRow: 1 }} ref={attachStrip} onPointerDown={beginScrub}>
            {view.ticks.map((label, i) => (
              <span key={i} style={{ display: "contents" }}>
                <span className="tick-label">{label}</span>
                {i < view.ticks.length - 1 && <span className="dots" />}
              </span>
            ))}
            <span className="knob" style={{ left: `${view.playheadPct}%` }}>
              {view.timeText}
            </span>
          </div>

          {view.lanes.map((lane, i) => (
            <Fragment key={lane.id}>
              <div className="lane-head" style={{ gridRow: i + 2 }}>
                <LaneIcon kind={lane.kind} />
                <span className="lane-name">{lane.name}</span>
                <button
                  className="lane-btn"
                  disabled={busy}
                  title={KIND_ADD_TITLE[lane.kind]}
                  onClick={() =>
                    lane.kind === "text" ? actions.addTextClip(lane.id) : actions.pickTrackMedia(lane.id)
                  }
                >
                  <Plus />
                </button>
                <button
                  className="lane-btn"
                  disabled={busy || !lane.canUp}
                  title="Move track up"
                  onClick={() => actions.moveTrack(lane.id, -1)}
                >
                  <ArrowUp />
                </button>
                <button
                  className="lane-btn"
                  disabled={busy || !lane.canDown}
                  title="Move track down"
                  onClick={() => actions.moveTrack(lane.id, 1)}
                >
                  <ArrowDown />
                </button>
                <button className="lane-btn" disabled={busy} title="Remove track" onClick={() => actions.removeTrack(lane.id)}>
                  <X />
                </button>
              </div>
              <div className="lane-track" style={{ gridRow: i + 2 }} onPointerDown={(e) => emptyLaneClick(lane, e)}>
                {lane.clips.map((clip) => (
                  <ClipBody
                    key={clip.id}
                    clip={clip}
                    razor={razor}
                    onDrag={beginClipDrag}
                    onCut={beginClipCut}
                    onDelete={() => actions.deleteClip(clip.id)}
                    onDeleteRipple={() => actions.rippleDeleteClip(clip.id)}
                    onSpeed={(speed) => actions.setClipSpeed(clip.id, speed)}
                    onText={(text) => actions.setClipText(clip.id, text)}
                  />
                ))}
              </div>
            </Fragment>
          ))}
          <div className="lane-add" style={{ gridRow: laneRows }}>
            <span>Add track</span>
            {(["video", "image", "text", "audio"] as const).map((kind) => (
              <button key={kind} className="lane-add-btn" disabled={busy} onClick={() => actions.addTrack(kind)}>
                <Plus />
                {KIND_LABEL[kind]}
              </button>
            ))}
          </div>
          <div className="tl-overlay" style={{ gridRow: `2 / ${laneRows}` }}>
            {view.trimActive && (
              <div
                className="lane-trim"
                style={{ left: `${view.trimLeftPct}%`, width: `${view.trimWidthPct}%` }}
              />
            )}
            <div className="playhead" style={{ left: `${view.playheadPct}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function LaneIcon({ kind }: { kind: TrackKind }) {
  const Icon = KIND_ICON[kind];
  return <Icon />;
}

// Modifiers on the body: Alt slips the source window, Ctrl/Meta slides the run.
function bodyMode(e: React.PointerEvent, kind: ClipView["kind"]): ClipDragMode {
  if (kind !== "video" && kind !== "audio") return "move";
  if (e.altKey) return "slip";
  if (e.ctrlKey || e.metaKey) return "slide";
  return "move";
}

function ClipBody(props: {
  clip: ClipView;
  razor: boolean;
  onDrag: (e: React.PointerEvent, clipId: string, mode: ClipDragMode) => void;
  onCut: (e: React.PointerEvent, clipId: string) => void;
  onDelete: () => void;
  onDeleteRipple: () => void;
  onSpeed: (speed: number) => void;
  onText: (text: string) => void;
}) {
  const { clip, razor, onDrag, onCut, onDelete, onDeleteRipple, onSpeed, onText } = props;
  const Icon = KIND_ICON[clip.kind];
  const media = clip.kind === "video" || clip.kind === "audio";
  return (
    <div
      className={`clip-body kind-${clip.kind}${clip.selected ? " selected" : ""}`}
      style={{
        left: `${clip.leftPct}%`,
        width: `${clip.widthPct}%`,
        backgroundImage: clip.tile ? `url(${clip.tile})` : undefined,
      }}
      title={
        media
          ? "Drag to move; Alt-drag slips the content inside the frame; Ctrl/Cmd-drag slides the run."
          : "Drag to move the clip along its lane."
      }
      onPointerDown={(e) => (razor ? onCut(e, clip.id) : onDrag(e, clip.id, bodyMode(e, clip.kind)))}
    >
      {clip.filmstrip && (
        <span
          className="clip-film"
          style={{ backgroundImage: clip.filmstrip.map((u) => `url(${u})`).join(", ") }}
        />
      )}
      {clip.text != null && clip.selected ? (
        // Edited in place; the keyboard actor skips INPUT so space still types
        <input
          className="clip-text"
          value={clip.text}
          placeholder="Type caption…"
          autoFocus
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => onText(e.target.value)}
        />
      ) : (
        <span className="clip-label">
          <Icon />
          {clip.label}
        </span>
      )}
      {clip.speed != null &&
        (clip.selected ? (
          <select
            className="clip-speed"
            value={String(clip.speed)}
            title="Clip speed"
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => onSpeed(Number(e.target.value))}
          >
            {SPEED_PRESETS.map((s) => (
              <option key={s} value={String(s)}>
                {String(s)}x
              </option>
            ))}
          </select>
        ) : clip.speed !== 1 ? (
          <span className="clip-speed">{String(clip.speed)}x</span>
        ) : null)}
      <button
        className="clip-del"
        title="Delete clip (Shift: close the gap)"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => (e.shiftKey ? onDeleteRipple() : onDelete())}
      >
        <X />
      </button>
      {!razor && (
        <>
          <span className="clip-edge left" onPointerDown={(e) => onDrag(e, clip.id, "left")} />
          <span className="clip-edge right" onPointerDown={(e) => onDrag(e, clip.id, "right")} />
        </>
      )}
    </div>
  );
}