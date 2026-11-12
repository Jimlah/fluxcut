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

export type VolumeKeyframe = { t: Sec; g: number };

export type MixParams = {
  /** Linear gain multiplier. */
  gain: number;
  /** Clip-local composition seconds, sorted by t. */
  keyframes: VolumeKeyframe[];
  eqOn: boolean;
  eqLowDb: number;
  eqMidDb: number;
  eqHighDb: number;
  compressOn: boolean;
  compressAmount: number;
  /** High-pass + expander cleanup against steady hiss and hum. */
  cleanOn: boolean;
};

export type VideoClip = {
  id: ClipId;
  kind: "video";
  start: Sec;
  duration: Sec;
  assetId: AssetId;
  sourceStart: Sec;
  /** Composition seconds per source second (0.25 = slow motion, 8 = timelapse). */
  speed: number;
  mix: MixParams;
};
export type AudioClip = {
  id: ClipId;
  kind: "audio";
  start: Sec;
  duration: Sec;
  assetId: AssetId;
  sourceStart: Sec;
  /** Composition seconds per source second (0.25 = slow motion, 8 = timelapse). */
  speed: number;
  mix: MixParams;
};
export type ImageClip = { id: ClipId; kind: "image"; start: Sec; duration: Sec; assetId: AssetId };
export type TextClip = { id: ClipId; kind: "text"; start: Sec; duration: Sec; text: string };
export type Clip = VideoClip | AudioClip | ImageClip | TextClip;

export type Track =
  | { id: TrackId; kind: "video"; name: string; duck: boolean; clips: VideoClip[] }
  | { id: TrackId; kind: "image"; name: string; clips: ImageClip[] }
  | { id: TrackId; kind: "text"; name: string; clips: TextClip[] }
  | { id: TrackId; kind: "audio"; name: string; duck: boolean; clips: AudioClip[] };

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
/** Clip speed bounds (composition sec / source sec) and the UI presets in between. */
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 8;
export const SPEED_PRESETS: number[] = [0.25, 0.5, 1, 1.5, 2, 4, 8];

// ---- audio mixer parameters (sound-carrying clips + ducking tracks) ----

/** Linear gain and keyframe gain bounds. */
export const MIX_GAIN_MAX = 2;
/** EQ band range in dB per direction. */
export const EQ_DB_MAX = 24;
/** Bound on the compressor amount knob. */
export const COMP_AMOUNT_MAX = 1;
/** Upper keyframe count per clip. */
export const MAX_KEYFRAMES = 64;
/** A keyframe delete matches the nearest point within this distance. */
export const KEYFRAME_MATCH_SEC = 0.01;

/** Mix slider patch: each present field is clamped, not rejected. */
export type SettableMix = {
  gain?: number;
  eqOn?: boolean;
  eqLowDb?: number;
  eqMidDb?: number;
  eqHighDb?: number;
  compressOn?: boolean;
  compressAmount?: number;
  cleanOn?: boolean;
};

const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clampGain = (v: number) => clampNum(Number(v) || 0, 0, MIX_GAIN_MAX);
const clampDb = (v: number) => clampNum(Number(v) || 0, -EQ_DB_MAX, EQ_DB_MAX);
const clamp01 = (v: number) => clampNum(Number(v) || 0, 0, COMP_AMOUNT_MAX);

/** Fresh defaults every call; a MixParams is never shared between clips. */
export function defaultMix(): MixParams {
  return {
    gain: 1,
    keyframes: [],
    eqOn: false,
    eqLowDb: 0,
    eqMidDb: 0,
    eqHighDb: 0,
    compressOn: false,
    compressAmount: 0.5,
    cleanOn: false,
  };
}

/** Drops duplicate/out-of-order/out-of-span points and clamps gains. */
export function normalizeKeyframes(keyframes: VolumeKeyframe[], duration: Sec): VolumeKeyframe[] {
  const sorted = [...keyframes].sort((a, b) => a.t - b.t);
  const out: VolumeKeyframe[] = [];
  for (const k of sorted) {
    const t = clampNum(Number(k.t) || 0, 0, Math.max(0, duration));
    const g = clampGain(k.g);
    const prev = out[out.length - 1];
    if (prev && t - prev.t < 1e-6) continue;
    out.push({ t, g });
  }
  return out;
}


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
  return clip.sourceStart + (time - clip.start) * clip.speed;
}

/** Source seconds on the main video clip → composition time; null outside it. */
export function sourceToComp(tl: Timeline, sourceTime: Sec): Sec | null {
  const clip = primaryVideoClip(tl);
  if (!clip) return null;
  const offset = sourceTime - clip.sourceStart;
  if (offset < 0 || offset > clip.duration * clip.speed) return null;
  return clip.start + offset / clip.speed;
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
    // Imported audio defaults to a ducker; video lanes carry the dialogue by default.
    ...(kind === "audio" ? { duck: true } : kind === "video" ? { duck: false } : {}),
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

/** Deletes the clip and closes the gap: same-track clips starting at or after it slide left. */
export function rippleDeleteClip(tl: Timeline, clipId: ClipId): Timeline | null {
  const entry = findClipEntry(tl, clipId);
  if (!entry) return null;
  const gone = entry.clip;
  return {
    ...withTrack(tl, entry.track.id, (t) => ({
      ...t,
      clips: t.clips
        .filter((c) => c.id !== clipId)
        .map((c) => (c.start >= gone.start ? { ...c, start: c.start - gone.duration } : c)),
    }) as Track),
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

// Razor cut: the piece left of compTime keeps the clip id (references stay valid),
// the fresh right piece carries the source window from the cut on.
export function splitClip(
  tl: Timeline,
  clipId: ClipId,
  compTime: Sec
): { timeline: Timeline; rightClipId: ClipId } | null {
  const entry = findClipEntry(tl, clipId);
  if (!entry) return null;
  const { track, clip } = entry;
  const leftDur = compTime - clip.start;
  const rightDur = clip.duration - leftDur;
  if (leftDur < MIN_CLIP_SEC || rightDur < MIN_CLIP_SEC) return null;
  const idx = track.clips.findIndex((c) => c.id === clipId);
  // Keyframes are clip-local, so a split redistributes them: the left piece
  // keeps its own tail (dropping points beyond the new span), the right piece
  // shifts the other tail to its own origin.
  const isMedia = clip.kind === "video" || clip.kind === "audio";
  const leftClip: Clip = isMedia
    ? {
        ...clip,
        duration: leftDur,
        mix: {
          ...clip.mix,
          keyframes: normalizeKeyframes(
            clip.mix.keyframes.filter((k) => k.t < leftDur),
            leftDur
          ),
        },
      }
    : { ...clip, duration: leftDur };
  const rightClip: Clip = isMedia
    ? {
        ...clip,
        id: newClipId(),
        start: compTime,
        duration: rightDur,
        sourceStart: clip.sourceStart + leftDur * clip.speed,
        mix: {
          ...clip.mix,
          keyframes: normalizeKeyframes(
            clip.mix.keyframes
              .filter((k) => k.t >= leftDur)
              .map((k) => ({ ...k, t: k.t - leftDur })),
            rightDur
          ),
        },
      }
    : { ...clip, id: newClipId(), start: compTime, duration: rightDur };
  // Replace the left piece at its index with left + right in one splice.
  const clips = [...track.clips];
  clips.splice(idx, 1, leftClip, rightClip);
  return {
    timeline: withTrack(tl, track.id, () => ({ ...track, clips }) as Track),
    rightClipId: rightClip.id,
  };
}

// Retimes a media clip in place: the source window keeps its length, so the
// composition duration rescales by old/new and must still fit the track and
// the asset. Null for non-media clips and any broken bound.
export function setClipSpeed(tl: Timeline, clipId: ClipId, speed: number): Timeline | null {
  const entry = findClipEntry(tl, clipId);
  if (!entry || (entry.clip.kind !== "video" && entry.clip.kind !== "audio")) return null;
  const src = entry.clip;
  if (!(speed >= SPEED_MIN && speed <= SPEED_MAX)) return null;
  const duration = src.duration * src.speed / speed;
  if (duration < MIN_CLIP_SEC) return null;
  if (overlaps(entry.track, src.start, src.start + duration, src.id)) return null;
  const asset = getAsset(tl, src.assetId);
  if (!asset || asset.kind !== src.kind || src.sourceStart + duration * speed > asset.duration + EPS) return null;
  const updated: Clip = { ...src, duration, speed };
  return withTrack(tl, entry.track.id, () => withClip(entry.track, src.id, updated));
}

// ---- mixer edits (sound-carrying clips and tracks only) ----

const isMediaClip = (clip: Clip): clip is VideoClip | AudioClip =>
  clip.kind === "video" || clip.kind === "audio";

/** Applies a slider patch onto one clip's mix, clamping every bounded value.
 * Null on a missing or non-media target; an all-noop patch keeps the input. */
export function setClipMix(tl: Timeline, clipId: ClipId, patch: SettableMix): Timeline | null {
  const entry = findClipEntry(tl, clipId);
  if (!entry || !isMediaClip(entry.clip)) return null;
  const clip = entry.clip;
  const mix = clip.mix;
  const next: MixParams = {
    gain: patch.gain != null ? clampGain(patch.gain) : mix.gain,
    keyframes: mix.keyframes,
    eqOn: patch.eqOn ?? mix.eqOn,
    eqLowDb: patch.eqLowDb != null ? clampDb(patch.eqLowDb) : mix.eqLowDb,
    eqMidDb: patch.eqMidDb != null ? clampDb(patch.eqMidDb) : mix.eqMidDb,
    eqHighDb: patch.eqHighDb != null ? clampDb(patch.eqHighDb) : mix.eqHighDb,
    compressOn: patch.compressOn ?? mix.compressOn,
    compressAmount: patch.compressAmount != null ? clamp01(patch.compressAmount) : mix.compressAmount,
    cleanOn: patch.cleanOn ?? mix.cleanOn,
  };
  const unchanged = next.gain === mix.gain && next.eqOn === mix.eqOn && next.eqLowDb === mix.eqLowDb &&
    next.eqMidDb === mix.eqMidDb && next.eqHighDb === mix.eqHighDb &&
    next.compressOn === mix.compressOn && next.compressAmount === mix.compressAmount &&
    next.cleanOn === mix.cleanOn;
  if (unchanged) return tl;
  return withTrack(tl, entry.track.id, () => withClip(entry.track, clipId, { ...clip, mix: next }));
}

/** Upserts one keyframe in clip-local composition time: an existing point
 * within 1ms of t replaces its gain, otherwise the point inserts sorted.
 * At the 64-point cap a brand-new time is a no-op (same timeline). */
export function upsertClipKeyframe(
  tl: Timeline,
  clipId: ClipId,
  t: Sec,
  g: number
): Timeline | null {
  const entry = findClipEntry(tl, clipId);
  if (!entry || !isMediaClip(entry.clip)) return null;
  const clip = entry.clip;
  const mix = clip.mix;
  // Stored points stay verbatim: an out-of-span point left by an earlier trim
  // is never evaluated and never shifted; only the point being written clamps.
  const keyframes = mix.keyframes;
  const at = clampNum(t, 0, Math.max(0, clip.duration));
  const gain = clampGain(g);
  const i = keyframes.findIndex((k) => Math.abs(k.t - at) < 1e-3);
  if (i === -1 && keyframes.length >= MAX_KEYFRAMES) return tl;
  const nextKeyframes = i === -1
    ? [...keyframes, { t: at, g: gain }].sort((a, b) => a.t - b.t)
    : keyframes.map((k, j) => (j === i ? { t: k.t, g: gain } : k));
  const unchanged = i !== -1 && keyframes[i].g === gain;
  if (unchanged) return tl;
  return withTrack(tl, entry.track.id, () =>
    withClip(entry.track, clipId, {
      ...clip,
      mix: { ...mix, keyframes: nextKeyframes },
    })
  );
}

/** Removes the nearest keyframe within KEYFRAME_MATCH_SEC; no match keeps state. */
export function removeClipKeyframe(tl: Timeline, clipId: ClipId, t: Sec): Timeline | null {
  const entry = findClipEntry(tl, clipId);
  if (!entry || !isMediaClip(entry.clip)) return null;
  const clip = entry.clip;
  const keyframes = clip.mix.keyframes;
  const nearest = keyframes.reduce<VolumeKeyframe | null>((best, k) => {
    if (best == null || Math.abs(k.t - t) < Math.abs(best.t - t)) return k;
    return best;
  }, null);
  if (!nearest || Math.abs(nearest.t - t) > KEYFRAME_MATCH_SEC) return tl;
  return withTrack(tl, entry.track.id, () =>
    withClip(entry.track, clipId, {
      ...clip,
      mix: {
        ...clip.mix,
        keyframes: keyframes.filter((k) => k !== nearest),
      },
    })
  );
}

/** Wipes one clip's mixer back to defaults (keyframes included). */
export function resetClipMix(tl: Timeline, clipId: ClipId): Timeline | null {
  const entry = findClipEntry(tl, clipId);
  if (!entry || !isMediaClip(entry.clip)) return null;
  const clip = entry.clip;
  const fresh = defaultMix();
  const mix = clip.mix;
  const clean =
    mix.gain === fresh.gain && mix.eqOn === false && mix.eqLowDb === 0 && mix.eqMidDb === 0 &&
    mix.eqHighDb === 0 && mix.compressOn === false && mix.compressAmount === fresh.compressAmount &&
    mix.cleanOn === false && mix.keyframes.length === 0;
  if (clean) return tl;
  return withTrack(tl, entry.track.id, () => withClip(entry.track, clipId, { ...clip, mix: fresh }));
}

/** Toggles the duck-under-dialogue policy of a sound-carrying track; null otherwise. */
export function setTrackDuck(tl: Timeline, trackId: TrackId, duck: boolean): Timeline | null {
  const track = findTrack(tl, trackId);
  if (!track || (track.kind !== "video" && track.kind !== "audio")) return null;
  if (track.duck === duck) return tl;
  return {
    ...tl,
    tracks: tl.tracks.map((t) =>
      t.id === trackId && (t.kind === "video" || t.kind === "audio") ? { ...t, duck } : t
    ),
  };
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
      ? { id: newClipId(), kind: "video", start: at, duration, assetId: asset.id, sourceStart: 0, speed: 1, mix: defaultMix() }
      : asset.kind === "audio"
        ? { id: newClipId(), kind: "audio", start: at, duration, assetId: asset.id, sourceStart: 0, speed: 1, mix: defaultMix() }
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

export type ClipDragMode = "move" | "left" | "right" | "slip" | "slide";
export interface ClipDragState {
  clipId: ClipId;
  mode: ClipDragMode;
  /** Last accepted pointer time on the lane — the drag anchor. */
  anchorTime: Sec;
}

// The two immediate sorted neighbors of the clip, tight to it within EPS.
function slideRun(track: Track, clip: Clip): { left: Clip; right: Clip } | null {
  const sorted = [...track.clips].sort((a, b) => a.start - b.start);
  const i = sorted.findIndex((c) => c.id === clip.id);
  if (i < 1 || i >= sorted.length - 1) return null;
  const left = sorted[i - 1];
  const right = sorted[i + 1];
  if (Math.abs(clipEnd(left) - clip.start) > EPS) return null;
  if (Math.abs(right.start - clipEnd(clip)) > EPS) return null;
  return { left, right };
}

// Slides a contiguous three-clip run as one seam: the target frame moves by d,
// the left neighbor stretches to it and the right one shrinks to follow, with
// each media window re-derived from its own speed. Null on any bounds hit.
function planSlide(tl: Timeline, track: Track, run: { left: Clip; right: Clip }, clip: Clip, delta: Sec): Track | null {
  const { left, right } = run;
  const newStart = Math.max(0, clip.start + delta);
  const d = newStart - clip.start;
  if (d === 0) return null;
  const leftDur = newStart - left.start;
  if (leftDur < MIN_CLIP_SEC) return null;
  if (left.kind === "video" || left.kind === "audio") {
    const la = tl.assets[left.assetId];
    if (!la || la.kind !== left.kind || left.sourceStart + leftDur * left.speed > la.duration + EPS) return null;
  }
  const rightDur = right.duration - d;
  if (rightDur < MIN_CLIP_SEC) return null;
  const rightStart = newStart + clip.duration;
  if (right.kind === "video" || right.kind === "audio") {
    if (right.sourceStart + d * right.speed < 0) return null;
  }
  const rightUpdated: Clip =
    right.kind === "video" || right.kind === "audio"
      ? { ...right, start: rightStart, duration: rightDur, sourceStart: right.sourceStart + d * right.speed }
      : { ...right, start: rightStart, duration: rightDur };
  const targetUpdated: Clip = { ...clip, start: newStart };
  const leftUpdated: Clip = { ...left, duration: leftDur };
  return withClip(withClip(withClip(track, clip.id, targetUpdated), left.id, leftUpdated), right.id, rightUpdated);
}

/**
 * Candidate layout for one drag step, recomputed from the last anchor so a
 * rejected candidate never accumulates. Null means: keep the previous state.
 * Alt (slip) moves the source window behind a fixed frame; Ctrl/Meta (slide)
 * keeps a contiguous run glued at the limits instead of corrupting the layout.
 */
export function planClipDrag(tl: Timeline, drag: ClipDragState, time: Sec): Timeline | null {
  const entry = findClipEntry(tl, drag.clipId);
  if (!entry) return null;
  const { track, clip } = entry;
  const delta = time - drag.anchorTime;
  if (delta === 0) return null;

  // A slide without a contiguous three-clip run behaves exactly like a move.
  if (drag.mode === "slide") {
    const run = slideRun(track, clip);
    if (run) {
      const slid = planSlide(tl, track, run, clip, delta);
      return slid ? withTrack(tl, track.id, () => slid) : null;
    }
  }

  const src = clip.kind === "video" || clip.kind === "audio" ? clip : null;

  // Slip: the frame stays fixed; the source window slides behind it.
  if (drag.mode === "slip") {
    if (!src) return null;
    const asset = getAsset(tl, src.assetId);
    if (!asset || asset.kind !== src.kind) return null;
    const sourceStart = src.sourceStart + delta * src.speed;
    if (sourceStart < 0 || sourceStart + clip.duration * src.speed > asset.duration + EPS) return null;
    return withTrack(tl, track.id, () => withClip(track, clip.id, { ...src, sourceStart }));
  }

  let sourceStart = src ? src.sourceStart : null;
  let start = clip.start;
  let duration = clip.duration;

  if (drag.mode === "move" || drag.mode === "slide") {
    start = Math.max(0, clip.start + delta);
    if (overlaps(track, start, start + duration, clip.id)) return null;
  } else if (drag.mode === "left") {
    start = clip.start + delta;
    duration = clipEnd(clip) - start;
    if (src) sourceStart = src.sourceStart + delta * src.speed;
    if (overlaps(track, start, clipEnd(clip), clip.id)) return null;
  } else {
    duration = clip.duration + delta;
    if (overlaps(track, clip.start, start + duration, clip.id)) return null;
  }

  if (start < 0 || duration < MIN_CLIP_SEC) return null;
  if (src && sourceStart != null) {
    const asset = getAsset(tl, src.assetId);
    const outOfSource =
      !asset ||
      asset.kind !== src.kind ||
      sourceStart < 0 ||
      sourceStart + duration * src.speed > asset.duration + EPS;
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
    speed: 1,
    mix: defaultMix(),
  };
  const track: Track = { id: newTrackId(), kind: "video", name: KIND_LABEL.video + " 1", duck: false, clips: [clip] };
  return {
    tracks: [track],
    assets: { ...tl.assets, [asset.id]: asset },
    primaryVideoClipId: clip.id,
  };
}