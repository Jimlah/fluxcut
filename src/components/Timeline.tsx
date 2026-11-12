import { useCallback } from "react";
import {
  ArrowDown,
  ArrowUp,
  AudioLines,
  Clapperboard,
  Image as ImageIcon,
  Plus,
  Type,
  X,
  type LucideIcon,
} from "lucide-react";
import { DEMO_THUMBS, useFluxcutActions, useTimelineView } from "../lib/useFluxcut";
import type { ClipView, LaneView } from "../lib/useFluxcut";
import type { ClipDragMode, TrackKind } from "../lib/timeline";

const KIND_ICON: Record<TrackKind, LucideIcon> = {
  video: Clapperboard,
  image: ImageIcon,
  text: Type,
  audio: AudioLines,
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
 */
export default function Timeline() {
  const actions = useFluxcutActions();
  const view = useTimelineView();

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

  const emptyLaneClick = (lane: LaneView) => {
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

  return (
    <div className="timeline-dock">
      <div className="ruler" ref={attachStrip} onPointerDown={beginScrub}>
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

      <div className="lanes">
        <div className="lanes-inner">
          {view.trimActive && (
            <div
              className="lane-trim"
              style={{ left: `${view.trimLeftPct}%`, width: `${view.trimWidthPct}%` }}
            />
          )}
          {view.lanes.map((lane) => (
            <div className="lane-row" key={lane.id}>
              <div className="lane-head">
                <LaneIcon kind={lane.kind} />
                <span className="lane-name">{lane.name}</span>
                <button
                  className="lane-btn"
                  title={KIND_ADD_TITLE[lane.kind]}
                  onClick={() =>
                    lane.kind === "text" ? actions.addTextClip(lane.id) : actions.pickTrackMedia(lane.id)
                  }
                >
                  <Plus />
                </button>
                <button
                  className="lane-btn"
                  title="Move track up"
                  disabled={!lane.canUp}
                  onClick={() => actions.moveTrack(lane.id, -1)}
                >
                  <ArrowUp />
                </button>
                <button
                  className="lane-btn"
                  title="Move track down"
                  disabled={!lane.canDown}
                  onClick={() => actions.moveTrack(lane.id, 1)}
                >
                  <ArrowDown />
                </button>
                <button className="lane-btn" title="Remove track" onClick={() => actions.removeTrack(lane.id)}>
                  <X />
                </button>
              </div>
              <div className="lane-track" onPointerDown={() => emptyLaneClick(lane)}>
                {lane.clips.map((clip) => (
                  <ClipBody
                    key={clip.id}
                    clip={clip}
                    onDrag={beginClipDrag}
                    onDelete={() => actions.deleteClip(clip.id)}
                    onText={(text) => actions.setClipText(clip.id, text)}
                  />
                ))}
              </div>
            </div>
          ))}
          <div className="lane-add">
            <span>Add track</span>
            {(["video", "image", "text", "audio"] as const).map((kind) => (
              <button key={kind} className="lane-add-btn" onClick={() => actions.addTrack(kind)}>
                <Plus />
                {KIND_LABEL[kind]}
              </button>
            ))}
          </div>
          <div className="playhead" style={{ left: `${view.playheadPct}%` }} />
        </div>
      </div>
    </div>
  );
}

const KIND_LABEL: Record<TrackKind, string> = {
  video: "Video",
  image: "Image",
  text: "Text",
  audio: "Audio",
};

function LaneIcon({ kind }: { kind: TrackKind }) {
  const Icon = KIND_ICON[kind];
  return <Icon />;
}

function ClipBody(props: {
  clip: ClipView;
  onDrag: (e: React.PointerEvent, clipId: string, mode: ClipDragMode) => void;
  onDelete: () => void;
  onText: (text: string) => void;
}) {
  const { clip, onDrag, onDelete, onText } = props;
  const Icon = KIND_ICON[clip.kind];
  return (
    <div
      className={`clip-body kind-${clip.kind}${clip.selected ? " selected" : ""}`}
      style={{
        left: `${clip.leftPct}%`,
        width: `${clip.widthPct}%`,
        backgroundImage: clip.tile ? `url(${clip.tile})` : undefined,
      }}
      onPointerDown={(e) => onDrag(e, clip.id, "move")}
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
      <button
        className="clip-del"
        title="Delete clip"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onDelete}
      >
        <X />
      </button>
      <span className="clip-edge left" onPointerDown={(e) => onDrag(e, clip.id, "left")} />
      <span className="clip-edge right" onPointerDown={(e) => onDrag(e, clip.id, "right")} />
    </div>
  );
}
