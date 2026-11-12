import { useMemo, type ReactNode } from "react";
import { createActorContext } from "@xstate/react";
import type { ActorRefFrom, SnapshotFrom } from "xstate";
import { fluxcutMachine, statusOf } from "./machine";
import type { FluxcutContext as FluxcutMachineContext, FluxcutStatus } from "./machine";
import { RESOLUTIONS } from "./convert";
import { aspectLabel, fmtBytes, fmtTime } from "./video";
import {
  compToSource,
  compositionEnd,
  primaryVideoClip,
  sourceToComp,
  type Clip,
  type ClipDragMode,
  type ClipId,
  type TrackId,
  type TrackKind,
  type VideoAsset,
  type VisualClipKind,
} from "./timeline";

export type FluxcutActorRef = ActorRefFrom<typeof fluxcutMachine>;
export type FluxcutSnapshot = SnapshotFrom<FluxcutActorRef>;

/**
 * Official shared-actor plumbing from @xstate/react: one machine actor per
 * <FluxcutProvider>, with static hooks (useSelector / useActorRef) that throw
 * helpful errors outside the provider.
 */
export const FluxcutContext = createActorContext(fluxcutMachine);

/** Mount once, high in the tree — starts THE Fluxcut machine actor. */
export function FluxcutProvider({ children }: { children: ReactNode }) {
  return <FluxcutContext.Provider>{children}</FluxcutContext.Provider>;
}

/** Access the shared machine actor from any component. */
export function useFluxcut(): FluxcutActorRef {
  return FluxcutContext.useActorRef();
}

/** Subscribe to just the slice of the machine a component cares about. */
export function useFluxcutSelector<T>(
  selector: (snapshot: FluxcutSnapshot) => T,
  compare?: (a: T, b: T) => boolean
): T {
  return FluxcutContext.useSelector(selector, compare);
}

/**
 * Method-style facade over machine events.
 *
 * XState v5 is event-driven: `send` is the only way in, because the statechart
 * — not the caller — decides what an event means in the current state. These
 * helpers are pure sugar; each one emits exactly one event, so everything
 * stays inspectable in the Stately devtools.
 */
export function useFluxcutActions() {
  const send = useFluxcut().send;

  return useMemo(
    () => ({
      // ---- file workflow ----
      loadFile: (file: File) => send({ type: "LOAD_FILE", file }),
      loadUrl: (url: string) => send({ type: "LOAD_URL", url }),
      setUrlDraft: (value: string) => send({ type: "SET_URL_DRAFT", value }),
      submitUrl: () => send({ type: "SUBMIT_URL" }),
      dropFile: (file: File) => send({ type: "DROP_FILE", file }),
      pickFile: () => send({ type: "REQUEST_PICK_FILE" }),
      clear: () => send({ type: "CLEAR" }),
      convert: () => send({ type: "CONVERT" }),
      cancel: () => send({ type: "CANCEL" }),
      again: () => send({ type: "AGAIN" }),

      // ---- settings ----
      setFormat: (id: string) => send({ type: "SET_FORMAT", id }),
      setRes: (id: string) => send({ type: "SET_RES", id }),
      setQuality: (id: string) => send({ type: "SET_QUALITY", id }),
      setTrim: (trim: { start: number; end: number }) => send({ type: "SET_TRIM", trim }),
      resetTrim: () => send({ type: "RESET_TRIM" }),
      setIn: () => send({ type: "SET_IN_POINT" }),
      setOut: () => send({ type: "SET_OUT_POINT" }),

      // ---- composition playback (the machine owns time) ----
      play: () => send({ type: "PLAY" }),
      pause: () => send({ type: "PAUSE" }),
      togglePlay: () => send({ type: "TOGGLE_PLAY" }),
      seek: (time: number) => send({ type: "SEEK", time }),
      seekBy: (delta: number) => send({ type: "SEEK_BY", delta }),

      // ---- tracks & clips ----
      addTrack: (kind: TrackKind) => send({ type: "ADD_TRACK", kind }),
      removeTrack: (trackId: TrackId) => send({ type: "REMOVE_TRACK", trackId }),
      moveTrack: (trackId: TrackId, dir: -1 | 1) => send({ type: "MOVE_TRACK", trackId, dir }),
      addTextClip: (trackId: TrackId) => send({ type: "ADD_TEXT_CLIP", trackId }),
      setClipText: (clipId: ClipId, text: string) => send({ type: "SET_CLIP_TEXT", clipId, text }),
      selectClip: (clipId: ClipId | null) => send({ type: "SELECT_CLIP", clipId }),
      deleteClip: (clipId: ClipId) => send({ type: "CLIP_DELETE", clipId }),
      rippleDeleteClip: (clipId: ClipId | null) => send({ type: "CLIP_DELETE_RIPPLE", clipId }),
      cutClip: (clipId: ClipId | null, time: number | null) => send({ type: "CUT_CLIP", clipId, time }),
      setClipSpeed: (clipId: ClipId, speed: number) => send({ type: "SET_CLIP_SPEED", clipId, speed }),
      clipDragStart: (p: {
        clipId: ClipId;
        mode: ClipDragMode;
        time: number;
        element: HTMLDivElement;
        seconds: number;
      }) => send({ type: "CLIP_DRAG_START", ...p }),
      addMediaClip: (trackId: TrackId, file: File) => send({ type: "ADD_MEDIA_CLIP", trackId, file }),
      pickTrackMedia: (trackId: TrackId) => send({ type: "REQUEST_PICK_TRACK_MEDIA", trackId }),

      // ---- element lifecycle (ruler + file input) ----
      attachInput: (element: HTMLInputElement) => send({ type: "ATTACH_INPUT", element }),
      attachStrip: (element: HTMLDivElement) => send({ type: "ATTACH_STRIP", element }),
      detachStrip: () => send({ type: "DETACH_STRIP" }),

      // ---- ruler scrubbing ----
      dragStrip: (clientX: number) => send({ type: "DRAG_STRIP", clientX }),
      stripSeek: (pct: number) => send({ type: "STRIP_SEEK", pct }),

      // ---- chrome ----
      toggleGrid: () => send({ type: "TOGGLE_GRID" }),
      setPanelOpen: (open: boolean) => send({ type: "SET_PANEL_OPEN", open }),
      togglePanel: () => send({ type: "TOGGLE_PANEL" }),
      setTool: (tool: string) => send({ type: "SET_TOOL", tool }),
      setProjectName: (name: string) => send({ type: "SET_PROJECT_NAME", name }),
    }),
    [send]
  );
}

/** Shallow-compare plain objects — pairs with useFluxcutFields. */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => Object.is(v, b[i]));
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]
  );
}

/**
 * Subscribe to several context fields at once and destructure in one go:
 *
 *   const { file, meta, trim } = useFluxcutFields(["file", "meta", "trim"]);
 *
 * Re-renders only when one of the picked fields actually changes
 * (shallow comparison), not on every context mutation — so unlike a raw
 * s.context selector it stays still while time/progress/dragOver tick.
 */
export function useFluxcutFields<K extends keyof FluxcutMachineContext>(
  keys: readonly K[]
): Pick<FluxcutMachineContext, K> {
  return useFluxcutSelector(
    (s) => {
      const out = {} as Pick<FluxcutMachineContext, K>;
      for (const key of keys) out[key] = s.context[key];
      return out;
    },
    shallowEqual
  );
}

/** The workflow status (idle/loading/converting/done) — derived from state tags. */
export function useFluxcutStatus(): FluxcutStatus {
  return useFluxcutSelector(statusOf);
}

/** True while any blocking workflow is active, probing media included. */
export function useFluxcutBusy(): boolean {
  return useFluxcutSelector((s) => {
    if (s.hasTag("addingClip")) return true;
    const st = statusOf(s);
    return st === "downloading" || st === "loading" || st === "converting";
  });
}

/* ---------- view model: the snapshot, pre-formatted ---------- */

export interface FluxcutView {
  aspect: string;
  resLabel: string;
  qualityTag: string;
  durationText: string;
  sizeHint: string;
  fileSizeText: string;
  metaDurationText: string;
  trimInText: string;
  trimLenText: string;
  trimOutText: string;
  resultSizeText: string;
  timeText: string;
  /** Composition-time landing spots for the skip-to-In/Out buttons (null → disabled). */
  trimInComp: number | null;
  trimOutComp: number | null;
  /** The playhead sits on the main clip → In/Out are usable. */
  trimSettable: boolean;
  trimHint: string;
}

const VIEW_MBPS: Record<string, number> = { "1080": 8, "720": 5, "480": 2.5, "360": 1.2 };

const TRIM_OFF_MAIN_HINT = "Move the playhead over the main video clip to trim.";

/** One selector that formats everything the UI renders as text. */
export function selectView(s: FluxcutSnapshot): FluxcutView {
  const c = s.context;
  const dur = c.meta.duration;
  const trimLen = Math.max(0, c.trim.end - c.trim.start);
  const eff = trimLen || dur;
  const q = c.qualityId === "high" ? 1 : c.qualityId === "medium" ? 0.6 : 0.35;

  return {
    aspect: aspectLabel(c.meta.w, c.meta.h) || "—",
    resLabel: RESOLUTIONS.find((r) => r.id === c.resId)?.label ?? "720p",
    qualityTag: c.qualityId === "high" ? "HQ" : c.qualityId === "medium" ? "MQ" : "LQ",
    durationText: c.fileUrl
      ? fmtTime(eff) + (trimLen && trimLen < dur ? " trim" : "")
      : "—",
    sizeHint: dur
      ? ` ≈ ${fmtBytes((((VIEW_MBPS[c.resId] ?? 8) * q * eff) / 8) * 1024 * 1024)}`
      : "",
    fileSizeText: c.file ? fmtBytes(c.file.size) : "",
    metaDurationText: fmtTime(dur),
    trimInText: fmtTime(c.trim.start),
    trimLenText: fmtTime(trimLen),
    trimOutText: fmtTime(c.trim.end),
    resultSizeText: c.result ? fmtBytes(c.result.size) : "",
    timeText: fmtTime(c.time),
    trimInComp: sourceToComp(c.timeline, c.trim.start),
    trimOutComp: sourceToComp(c.timeline, c.trim.end),
    trimSettable: compToSource(c.timeline, c.time) != null,
    trimHint: TRIM_OFF_MAIN_HINT,
  };
}

/**
 * The whole formatted view in one subscription — components destructure this
 * instead of importing fmtTime/fmtBytes/aspectLabel and deriving per render.
 * Re-renders only when a formatted value actually changes (shallow compare).
 */
export function useFluxcutView(): FluxcutView {
  return useFluxcutSelector(selectView, shallowEqual);
}

/* ---------- timeline view: lanes, ruler geometry, mode ---------- */

// Demo stills fetched from Mixkit (see README credits)
export const DEMO_THUMBS = [
  "https://assets.mixkit.co/videos/4188/4188-thumb-360-0.jpg", // festival stage (blue/purple)
  "https://assets.mixkit.co/videos/31469/31469-thumb-360-3.jpg", // blue/red water spray
  "https://assets.mixkit.co/videos/1834/1834-thumb-360-1.jpg", // multicolor space smoke
  "https://assets.mixkit.co/videos/46317/46317-thumb-360-3.jpg", // golden glitter
  "https://assets.mixkit.co/videos/3460/3460-thumb-360-0.jpg", // fire particles
  "https://assets.mixkit.co/videos/45597/45597-thumb-360-3.jpg", // red smoke on black
];

export interface ClipView {
  id: ClipId;
  kind: Clip["kind"];
  label: string;
  leftPct: number;
  widthPct: number;
  selected: boolean;
  /** Poster (video) or the image itself (image clips); null for audio/text. */
  tile: string | null;
  /** Filmstrip tiles on the primary video clip only. */
  filmstrip: string[] | null;
  text: string | null;
  /** Composition sec per source sec on video/audio; null otherwise. */
  speed: number | null;
}

export interface LaneView {
  id: TrackId;
  kind: TrackKind;
  name: string;
  clips: ClipView[];
  canUp: boolean;
  canDown: boolean;
}

export interface TimelineView {
  mode: "demo" | "live";
  /** Ruler window: compositionEnd floored at 10s so short projects breathe. */
  secondsVisible: number;
  ticks: string[];
  timeText: string;
  playheadPct: number;
  lanes: LaneView[];
  /** In/Out band projected onto the ruler through the main clip. */
  trimActive: boolean;
  trimLeftPct: number;
  trimWidthPct: number;
}

const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

/** The multi-lane timeline in one subscription. */
export function selectTimelineView(s: FluxcutSnapshot): TimelineView {
  const c = s.context;
  const tl = c.timeline;
  const live = tl.tracks.length > 0;
  const secondsVisible = live ? Math.max(compositionEnd(tl), 10) : 0;
  const pct = (t: number) =>
    secondsVisible > 0 ? (Math.min(t, secondsVisible) / secondsVisible) * 100 : 0;

  const ticks: string[] = [];
  if (live) {
    const step = TICK_STEPS.find((x) => x >= secondsVisible / 12) ?? 600;
    for (let t = 0; t <= secondsVisible + 1e-6; t += step) ticks.push(fmtTime(t));
  }

  // Visual lanes are a prefix; audio lanes follow. Reorder buttons may not
  // cross the boundary between the two sections.
  const firstAudio = tl.tracks.findIndex((t) => t.kind === "audio");
  const visualEnd = firstAudio === -1 ? tl.tracks.length : firstAudio;

  const lanes: LaneView[] = live
    ? tl.tracks.map((track, i) => ({
        id: track.id,
        kind: track.kind,
        name: track.name,
        canUp: track.kind === "audio" ? i > visualEnd : i > 0,
        canDown: track.kind === "audio" ? i < tl.tracks.length - 1 : i < visualEnd - 1,
        clips: track.clips.map((clip) => {
          const asset = "assetId" in clip ? tl.assets[clip.assetId] : undefined;
          return {
            id: clip.id,
            kind: clip.kind,
            label:
              clip.kind === "text" ? clip.text.trim() || "Text" : (asset?.name ?? "Clip"),
            leftPct: pct(clip.start),
            widthPct: pct(clip.start + clip.duration) - pct(clip.start),
            selected: clip.id === c.selectedClipId,
            tile:
              asset && asset.kind === "video"
                ? asset.poster || null
                : asset && asset.kind === "image"
                  ? asset.url
                  : null,
            filmstrip:
              clip.kind === "video" && tl.primaryVideoClipId === clip.id && c.frames.length
                ? c.frames
                : null,
            text: clip.kind === "text" ? clip.text : null,
            speed: clip.kind === "video" || clip.kind === "audio" ? clip.speed : null,
          };
        }),
      }))
    : [];

  let trimActive = false;
  let trimLeftPct = 0;
  let trimWidthPct = 0;
  if (live) {
    const inComp = sourceToComp(tl, c.trim.start);
    const outComp = sourceToComp(tl, c.trim.end);
    const primary = primaryVideoClip(tl);
    const asset = primary ? tl.assets[primary.assetId] : undefined;
    const sourceDur = asset && asset.kind === "video" ? asset.duration : 0;
    if (
      inComp != null &&
      outComp != null &&
      sourceDur > 0 &&
      (c.trim.start > 0.05 || c.trim.end < sourceDur - 0.05)
    ) {
      trimActive = true;
      trimLeftPct = pct(inComp);
      trimWidthPct = pct(outComp) - pct(inComp);
    }
  }

  return {
    mode: live ? "live" : "demo",
    secondsVisible,
    ticks,
    timeText: fmtTime(c.time),
    playheadPct: pct(c.time),
    lanes,
    trimActive,
    trimLeftPct,
    trimWidthPct,
  };
}

/** Timeline-specific subscription — isolates its high-frequency updates. */
export function useTimelineView(): TimelineView {
  return useFluxcutSelector(selectTimelineView, shallowEqual);
}

/* ---------- preview view model: one layer per clip, stacked by lane ---------- */

export interface PreviewMedia {
  src: string;
  /** Source seconds the media element should sit at for this comp time. */
  sourceTime: number;
  /** Composition sec per source sec — the compositor mirrors it on the element. */
  speed: number;
  active: boolean;
  elKind: "video" | "audio" | "image";
}

export interface PreviewLayer {
  clipId: ClipId;
  kind: VisualClipKind | "audio";
  /** z-order within the stage; visual lanes only (audio has none). */
  z: number;
  leftPct: number;
  widthPct: number;
  active: boolean;
  media: PreviewMedia | null;
  text: string | null;
}

export interface PreviewVM {
  layers: PreviewLayer[];
  time: number;
  playing: boolean;
  duration: number;
  /** Aspect of the primary (or first) video asset — derived, never stored. */
  dims: { w: number; h: number } | null;
}

/** The stacked stage preview: layers in lane order with sync targets. */
export function selectPreview(s: FluxcutSnapshot): PreviewVM {
  const c = s.context;
  const tl = c.timeline;
  const time = c.time;
  const isActive = (clip: Clip) => time >= clip.start && time < clip.start + clip.duration;
  const layers: PreviewLayer[] = [];

  const visualTotal = tl.tracks.filter((t) => t.kind !== "audio").length;
  tl.tracks.forEach((track, i) => {
    const visualBefore = tl.tracks.slice(0, i).filter((t) => t.kind !== "audio").length;
    const z = track.kind === "audio" ? 0 : visualTotal - visualBefore; // top lane highest
    for (const clip of track.clips) {
      const active = isActive(clip);
      if (clip.kind === "text") {
        layers.push({
          clipId: clip.id,
          kind: "text",
          z,
          leftPct: 0,
          widthPct: 100,
          active,
          media: null,
          text: clip.text,
        });
        continue;
      }
      const asset = tl.assets[clip.assetId];
      if (!asset) continue;
      layers.push({
        clipId: clip.id,
        kind: clip.kind,
        z,
        leftPct: 0,
        widthPct: 100,
        active,
        media: {
          src: asset.url,
          sourceTime:
            clip.kind === "video" || clip.kind === "audio"
              ? clip.sourceStart + Math.max(0, time - clip.start) * clip.speed
              : 0,
          speed: clip.kind === "video" || clip.kind === "audio" ? clip.speed : 1,
          active,
          elKind: clip.kind,
        },
        text: null,
      });
    }
  });

  const primary = primaryVideoClip(tl);
  const primaryAsset = primary ? tl.assets[primary.assetId] : undefined;
  const videoAsset =
    primaryAsset && primaryAsset.kind === "video"
      ? primaryAsset
      : Object.values(tl.assets).find((a): a is VideoAsset => a.kind === "video");

  return {
    layers,
    time,
    playing: c.playing,
    duration: compositionEnd(tl),
    dims:
      videoAsset && videoAsset.w > 0 && videoAsset.h > 0
        ? { w: videoAsset.w, h: videoAsset.h }
        : null,
  };
}

/** Compositor-specific subscription — updates on every clock tick. */
export function usePreview(): PreviewVM {
  return useFluxcutSelector(selectPreview, shallowEqual);
}
