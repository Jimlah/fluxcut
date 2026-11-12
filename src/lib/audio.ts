// Pure mix math for the preview mixer: keyframe envelopes and dialogue-ducking
// ramps. No DOM, no Web Audio — the engine (lib/audioEngine.ts) consumes
// mixGain() per clock tick. Null-on-illegal lives in timeline.ts; this module
// only evaluates already-valid state.
import type { ClipId, MixParams, Sec, Timeline, Track } from "./timeline";

/** A ducked track plays at this linear gain under dialogue (-12 dB). */
export const DUCK_AMOUNT = 0.25;
/** Linear ramp-in once dialogue starts, in composition seconds. */
export const DUCK_ATTACK_SEC = 0.04;
/** Linear ramp-out after dialogue ends, in composition seconds. */
export const DUCK_RELEASE_SEC = 0.5;

/**
 * Gain of one clip's keyframe envelope at clip-local composition time t.
 * Linear between neighbors; constant beyond the outermost points; 1 with no
 * keyframes. The baseline volume multiplies this at the call site.
 */
export function envelope(mix: MixParams, t: Sec): number {
  const kfs = mix.keyframes;
  if (kfs.length === 0) return 1;
  const first = kfs[0];
  const last = kfs[kfs.length - 1];
  if (t <= first.t) return first.g;
  if (t >= last.t) return last.g;
  for (let i = 1; i < kfs.length; i++) {
    const b = kfs[i];
    if (t <= b.t) {
      const a = kfs[i - 1];
      const span = b.t - a.t;
      if (span <= 0) return b.g;
      return a.g + ((b.g - a.g) * (t - a.t)) / span;
    }
  }
  return last.g;
}

/** Dialogue windows: every active window of every clip on a non-ducking
 * sound-carrying track (a ducker never ducks itself). */
function dialogueIntervals(tracks: Track[]): Array<[Sec, Sec]> {
  const out: Array<[Sec, Sec]> = [];
  for (const track of tracks) {
    if (track.kind !== "video" && track.kind !== "audio") continue;
    if (track.duck) continue;
    for (const clip of track.clips) out.push([clip.start, clip.start + clip.duration]);
  }
  return out;
}

/**
 * The ducking multiplier at composition time t: 1 unless a dialogue source is
 * live. Per dialogue interval, the factor is DUCK_AMOUNT inside the interval,
 * linear 1 -> DUCK_AMOUNT over ATTACK approaching the interval start and
 * linear back over RELEASE after its end. The min over all boundary terms
 * makes overlapping dialogues stay ducked through the whole overlap.
 */
export function duckFactor(tracks: Track[], t: Sec): number {
  const dialogues = dialogueIntervals(tracks);
  if (dialogues.length === 0) return 1;
  let factor = 1;
  for (const [start, end] of dialogues) {
    if (t >= start && t < end) {
      factor = Math.min(factor, DUCK_AMOUNT);
    } else if (t < start) {
      const lead = start - t;
      if (lead < DUCK_ATTACK_SEC) {
        const ramp = DUCK_AMOUNT + (1 - DUCK_AMOUNT) * (lead / DUCK_ATTACK_SEC);
        factor = Math.min(factor, ramp);
      }
    } else {
      const tail = t - end;
      if (tail <= DUCK_RELEASE_SEC) {
        const ramp = DUCK_AMOUNT + (1 - DUCK_AMOUNT) * (tail / DUCK_RELEASE_SEC);
        factor = Math.min(factor, ramp);
      }
    }
  }
  return Math.min(1, Math.max(DUCK_AMOUNT, factor));
}

/**
 * Final linear gain per sound-carrying clip at composition time t:
 * baseline x envelope x (ducking factor when the clip's track is a ducker).
 * Every sound-carrying clip gets an entry; the engine applies it per tick.
 */
export function mixGain(tl: Timeline, t: Sec): Map<ClipId, number> {
  const out = new Map<ClipId, number>();
  const duck = duckFactor(tl.tracks, t);
  for (const track of tl.tracks) {
    if (track.kind !== "video" && track.kind !== "audio") continue;
    const duckMul = track.duck ? duck : 1;
    for (const clip of track.clips) {
      const gain = clip.mix.gain * envelope(clip.mix, t - clip.start) * duckMul;
      out.set(clip.id, gain);
    }
  }
  return out;
}