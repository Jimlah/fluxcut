// Multi-track timeline domain — types, invariants, placement helpers.
//
// Two planes: an asset registry and an ordered track list holding kind-typed
// clip lists. Composition time (clip.start/duration) is decoupled from source
// time (clip.sourceStart, only on file-backed media with a duration), and
// every illegal change returns `null` so the caller keeps its previous state.
// Pure module: no DOM, no XState.

export type Sec = number;
export type AssetId = string;
export type TrackId = string;
export type ClipId = string;

export type VideoAsset = {
  id: AssetId;
  kind: "video";
  // Display name: the source file's base name (blob URLs carry none).
  name: string;
  url: string;
  duration: Sec;
  w: number;
  h: number;
  poster: string;
  frames?: string[];
};
export type AudioAsset = { id: AssetId; kind: "audio"; name: string; url: string; duration: Sec };
export type ImageAsset = { id: AssetId; kind: "image"; name: string; url: string; w: number; h: number };
export type Asset = VideoAsset | AudioAsset | ImageAsset;

export type VisualClipKind = "video" | "image" | "text";
export type TrackKind = VisualClipKind | "audio";

export type VideoClip = {
  id: ClipId;
  kind: "video";
  start: Sec;
  duration: Sec;
  assetId: AssetId;
  sourceStart: Sec;
};
export type AudioClip = {
  id: ClipId;
  kind: "audio";
  start: Sec;
  duration: Sec;
  assetId: AssetId;
  sourceStart: Sec;
};
export type ImageClip = { id: ClipId; kind: "image"; start: Sec; duration: Sec; assetId: AssetId };
export type TextClip = { id: ClipId; kind: "text"; start: Sec; duration: Sec; text: string };
export type Clip = VideoClip | AudioClip | ImageClip | TextClip;

export type Track =
  | { id: TrackId; kind: "video"; name: string; clips: VideoClip[] }
  | { id: TrackId; kind: "image"; name: string; clips: ImageClip[] }
  | { id: TrackId; kind: "text"; name: string; clips: TextClip[] }
  | { id: TrackId; kind: "audio"; name: string; clips: AudioClip[] };

export type Timeline = {
  /** INV: visual lanes first (z-order = position, top lane draws last), audio lanes after. */
  tracks: Track[];
  /** INV: every clip.assetId resolves here, and asset.kind === clip.kind. */
  assets: Record<AssetId, Asset>;
  /** The main source clip, or null once it is gone. */
  primaryVideoClipId: ClipId | null;
};

export const MIN_CLIP_SEC = 0.2;
/** Placeholder length for freshly inserted text/image segments. */
export const GROWTH_PLACEHOLDER_SEC = 3;

export const EMPTY_TIMELINE: Timeline = { tracks: [], assets: {}, primaryVideoClipId: null };

// Probed durations are fractional seconds; tolerate float drift at the bounds.
const EPS = 1e-3;

let idCounter = 0;
const freshId = (prefix: string) => `${prefix}${++idCounter}`;
export const newAssetId = () => freshId("asset:");
const newTrackId = () => freshId("track:");
const newClipId = () => freshId("clip:");

const KIND_LABEL: Record<TrackKind, string> = {
  video: "Video",
  image: "Image",
  text: "Text",
  audio: "Audio",
};
const isVisual = (kind: TrackKind) => kind !== "audio";

const clipEnd = (clip: Clip) => clip.start + clip.duration;

export function findTrack(tl: Timeline, trackId: TrackId): Track | null {
  return tl.tracks.find((t) => t.id === trackId) ?? null;
}

export function findClipEntry(tl: Timeline, clipId: ClipId): { track: Track; clip: Clip } | null {
  for (const track of tl.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

export function findClip(tl: Timeline, clipId: ClipId): Clip | null {
  return findClipEntry(tl, clipId)?.clip ?? null;
}

export function getAsset(tl: Timeline, assetId: AssetId): Asset | null {
  return tl.assets[assetId] ?? null;
}

export function primaryVideoClip(tl: Timeline): VideoClip | null {
  const clip = tl.primaryVideoClipId ? findClip(tl, tl.primaryVideoClipId) : null;
  return clip && clip.kind === "video" ? clip : null;
}

/** Composition end: max clip end, floored at 0. */
export function compositionEnd(tl: Timeline): Sec {
  let end = 0;
  for (const track of tl.tracks) {
    for (const clip of track.clips) end = Math.max(end, clip.start + clip.duration);
  }
  return end;
}

/** Composition time → source seconds on the main video clip; null off it. */
export function compToSource(tl: Timeline, time: Sec): Sec | null {
  const clip = primaryVideoClip(tl);
  if (!clip || time < clip.start || time >= clip.start + clip.duration) return null;
  return clip.sourceStart + (time - clip.start);
}

/** Source seconds on the main video clip → composition time; null outside it. */
export function sourceToComp(tl: Timeline, sourceTime: Sec): Sec | null {
  const clip = primaryVideoClip(tl);
  if (!clip) return null;
  const offset = sourceTime - clip.sourceStart;
  if (offset < 0 || offset > clip.duration) return null;
  return clip.start + offset;
}

/** Same-track overlap test over every clip except the one being placed. */
function overlaps(track: Track, start: Sec, end: Sec, ignore: ClipId): boolean {
  return track.clips.some((c) => c.id !== ignore && start < clipEnd(c) && end > c.start);
}

/**
 * First start ≥ `from` where a `duration` clip fits without overlap. Clips
 * never overlap by invariant, so one sorted pass walks past each blocker.
 */
function firstFreeStart(track: Track, from: Sec, duration: Sec): Sec {
  let start = Math.max(0, from);
  const sorted = [...track.clips].sort((a, b) => a.start - b.start);
  for (const c of sorted) {
    if (start < clipEnd(c) && start + duration > c.start) start = clipEnd(c);
  }
  return start;
}

export function registerAsset(tl: Timeline, asset: Asset): Timeline {
  return { ...tl, assets: { ...tl.assets, [asset.id]: asset } };
}

function withTrack(tl: Timeline, trackId: TrackId, update: (track: Track) => Track): Timeline {
  return {
    ...tl,
    tracks: tl.tracks.map((t) => (t.id === trackId ? update(t) : t)),
  };
}

// The caller guarantees the replacement carries the track's own kind.
function withClip(track: Track, clipId: ClipId, clip: Clip): Track {
  return {
    ...track,
    clips: track.clips.map((c) => (c.id === clipId ? (clip as typeof c) : c)),
  } as Track;
}

/** Appends a new track inside its section (visual prefix first, audio after). */
export function addTrack(tl: Timeline, kind: TrackKind): Timeline {
  const track = {
    id: newTrackId(),
    kind,
    name: `${KIND_LABEL[kind]} ${tl.tracks.filter((t) => t.kind === kind).length + 1}`,
    clips: [],
  } as Track;
  if (!isVisual(kind)) return { ...tl, tracks: [...tl.tracks, track] };
  const audioStart = tl.tracks.findIndex((t) => !isVisual(t.kind));
  if (audioStart === -1) return { ...tl, tracks: [...tl.tracks, track] };
  return {
    ...tl,
    tracks: [...tl.tracks.slice(0, audioStart), track, ...tl.tracks.slice(audioStart)],
  };
}

export function removeTrack(tl: Timeline, trackId: TrackId): Timeline {
  const track = findTrack(tl, trackId);
  if (!track) return tl;
  const primaryGone =
    tl.primaryVideoClipId != null && track.clips.some((c) => c.id === tl.primaryVideoClipId);
  return {
    tracks: tl.tracks.filter((t) => t.id !== trackId),
    assets: tl.assets,
    primaryVideoClipId: primaryGone ? null : tl.primaryVideoClipId,
  };
}

/** Swaps a lane with its neighbor; null when that crosses a section boundary. */
export function moveTrack(tl: Timeline, trackId: TrackId, dir: -1 | 1): Timeline | null {
  const i = tl.tracks.findIndex((t) => t.id === trackId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= tl.tracks.length) return null;
  if (isVisual(tl.tracks[i].kind) !== isVisual(tl.tracks[j].kind)) return null;
  const tracks = [...tl.tracks];
  [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
  return {
    tracks,
    assets: tl.assets,
    primaryVideoClipId: tl.primaryVideoClipId,
  };
}

export function deleteClip(tl: Timeline, clipId: ClipId): Timeline {
  const entry = findClipEntry(tl, clipId);
  if (!entry) return tl;
  return {
    ...withTrack(tl, entry.track.id, (t) => ({ ...t, clips: t.clips.filter((c) => c.id !== clipId) }) as Track),
    primaryVideoClipId: tl.primaryVideoClipId === clipId ? null : tl.primaryVideoClipId,
  };
}

export function setClipText(tl: Timeline, clipId: ClipId, text: string): Timeline | null {
  const entry = findClipEntry(tl, clipId);
  if (!entry || entry.clip.kind !== "text") return null;
  return withTrack(tl, entry.track.id, (t) => ({
    ...t,
    clips: t.clips.map((c) => (c.id === clipId ? { ...c, text } : c)),
  }) as Track);
}

/** Inserts an asset-backed clip at `start` (pushed right past any blocker). */
export function addMediaClip(
  tl: Timeline,
  trackId: TrackId,
  asset: Asset,
  start: Sec
): { timeline: Timeline; clipId: ClipId } | null {
  const track = findTrack(tl, trackId);
  if (!track || track.kind !== asset.kind) return null;
  const duration = asset.kind === "image" ? GROWTH_PLACEHOLDER_SEC : asset.duration;
  if (!(duration > 0)) return null;
  const at = firstFreeStart(track, start, duration);
  const clip: Clip =
    asset.kind === "video"
      ? { id: newClipId(), kind: "video", start: at, duration, assetId: asset.id, sourceStart: 0 }
      : asset.kind === "audio"
        ? { id: newClipId(), kind: "audio", start: at, duration, assetId: asset.id, sourceStart: 0 }
        : { id: newClipId(), kind: "image", start: at, duration, assetId: asset.id };
  return {
    timeline: withTrack(registerAsset(tl, asset), trackId, (t) => ({ ...t, clips: [...t.clips, clip] }) as Track),
    clipId: clip.id,
  };
}

/** Inserts a 3s text clip at `start`; returns the new clip id for selection. */
export function addTextClip(
  tl: Timeline,
  trackId: TrackId,
  start: Sec,
  text = ""
): { timeline: Timeline; clipId: ClipId } | null {
  const track = findTrack(tl, trackId);
  if (!track || track.kind !== "text") return null;
  const at = firstFreeStart(track, start, GROWTH_PLACEHOLDER_SEC);
  const clip: TextClip = { id: newClipId(), kind: "text", start: at, duration: GROWTH_PLACEHOLDER_SEC, text };
  return {
    timeline: withTrack(tl, trackId, (t) => ({ ...t, clips: [...t.clips, clip] }) as Track),
    clipId: clip.id,
  };
}

export type ClipDragMode = "move" | "left" | "right";
export interface ClipDragState {
  clipId: ClipId;
  mode: ClipDragMode;
  /** Last accepted pointer time on the lane — the drag anchor. */
  anchorTime: Sec;
}

/**
 * Candidate layout for one drag step, recomputed from the last anchor so a
 * rejected candidate never accumulates. Null means: keep the previous state.
 */
export function planClipDrag(tl: Timeline, drag: ClipDragState, time: Sec): Timeline | null {
  const entry = findClipEntry(tl, drag.clipId);
  if (!entry) return null;
  const { track, clip } = entry;
  const delta = time - drag.anchorTime;
  if (delta === 0) return null;

  const src = clip.kind === "video" || clip.kind === "audio" ? clip : null;
  let sourceStart = src ? src.sourceStart : null;
  let start = clip.start;
  let duration = clip.duration;

  if (drag.mode === "move") {
    start = Math.max(0, clip.start + delta);
    if (overlaps(track, start, start + duration, clip.id)) return null;
  } else if (drag.mode === "left") {
    start = clip.start + delta;
    duration = clipEnd(clip) - start;
    if (src) sourceStart = src.sourceStart + delta;
    if (overlaps(track, start, clipEnd(clip), clip.id)) return null;
  } else {
    duration = clip.duration + delta;
    if (overlaps(track, clip.start, start + duration, clip.id)) return null;
  }

  if (start < 0 || duration < MIN_CLIP_SEC) return null;
  if (src && sourceStart != null) {
    const asset = getAsset(tl, src.assetId);
    const outOfSource =
      !asset || asset.kind !== src.kind || sourceStart < 0 || sourceStart + duration > asset.duration + EPS;
    if (outOfSource) return null;
  }

  const updated: Clip =
    clip.kind === "video"
      ? { ...clip, start, duration, sourceStart: sourceStart as number }
      : clip.kind === "audio"
        ? { ...clip, start, duration, sourceStart: sourceStart as number }
        : clip.kind === "image"
          ? { ...clip, start, duration }
          : { ...clip, start, duration };
  return withTrack(tl, track.id, () => withClip(track, clip.id, updated));
}

/**
 * v1 bootstrap: registers the main video and lays one full-length clip on a
 * fresh "Video 1" lane, pointing primaryVideoClipId at its clip.
 */
export function bootstrapMainVideo(
  tl: Timeline,
  base: { url: string; duration: Sec; w: number; h: number; poster: string; frames?: string[]; name?: string }
): Timeline {
  const asset: VideoAsset = {
    id: newAssetId(),
    kind: "video",
    url: base.url,
    duration: base.duration,
    w: base.w,
    h: base.h,
    poster: base.poster,
    frames: base.frames,
    name: base.name ?? "Main video",
  };
  const clip: VideoClip = {
    id: newClipId(),
    kind: "video",
    start: 0,
    duration: asset.duration,
    assetId: asset.id,
    sourceStart: 0,
  };
  const track: Track = { id: newTrackId(), kind: "video", name: KIND_LABEL.video + " 1", clips: [clip] };
  return {
    tracks: [track],
    assets: { ...tl.assets, [asset.id]: asset },
    primaryVideoClipId: clip.id,
  };
}
