// Snapshot journal for undo/redo. The open slot is the transaction boundary:
// a drag gesture or a typing burst captures its baseline here and settles to
// at most one entry. Pure module: no DOM, no XState, no React.

import type { Clip, MixParams, Timeline, Track } from "./timeline";

export type HistoryEntry = { before: Timeline; after: Timeline };

export type OpenTransaction =
  | { kind: "drag"; key: string; before: Timeline }
  | { kind: "text"; key: string; before: Timeline }
  | { kind: "mix"; key: string; before: Timeline };

export type SnapshotJournal = {
  /** Completed steps, oldest first. Undo pops the newest; capped at 100. */
  past: HistoryEntry[];
  /** Steps undo took away; redo pops the newest. Cleared on any new commit. */
  future: HistoryEntry[];
  /** The one open transaction, exactly one at a time. */
  open: OpenTransaction | null;
};

/** Deep equality of mixer snapshots: scalars plus the keyframe list. */
function mixEquivalent(a: MixParams, b: MixParams): boolean {
  if (a === b) return true;
  return (
    a.gain === b.gain &&
    a.eqOn === b.eqOn && a.eqLowDb === b.eqLowDb && a.eqMidDb === b.eqMidDb &&
    a.eqHighDb === b.eqHighDb &&
    a.compressOn === b.compressOn && a.compressAmount === b.compressAmount &&
    a.cleanOn === b.cleanOn &&
    a.keyframes.length === b.keyframes.length &&
    a.keyframes.every((k, i) => k.t === b.keyframes[i].t && k.g === b.keyframes[i].g)
  );
}

/** Duck flag equality for the sound-carrying track variants. */
function trackExtraEquivalent(a: Track, b: Track): boolean {
  const aSound = a.kind === "video" || a.kind === "audio";
  const bSound = b.kind === "video" || b.kind === "audio";
  if (aSound !== bSound) return false;
  if (!aSound) return true;
  return (a as { duck: boolean }).duck === (b as { duck: boolean }).duck;
}

const CAP = 100;
// Float drift a "the gesture ended where it began" comparison tolerates.
const EPS = 1e-9;

const numEq = (a: number, b: number) => a === b || Math.abs(a - b) < EPS;

export function clipsEquivalent(a: Clip, b: Clip): boolean {
  if (a.id !== b.id || a.kind !== b.kind) return false;
  if (!numEq(a.start, b.start) || !numEq(a.duration, b.duration)) return false;
  const media = a.kind === "video" || a.kind === "audio";
  const mediaB = b.kind === "video" || b.kind === "audio";
  if (media !== mediaB) return false;
  if (media && mediaB) {
    return (
      a.assetId === b.assetId &&
      numEq(a.sourceStart, b.sourceStart) &&
      numEq(a.speed, b.speed) &&
      mixEquivalent((a as { mix: MixParams }).mix, (b as { mix: MixParams }).mix)
    );
  }
  if (a.kind === "image" && b.kind === "image") return a.assetId === b.assetId;
  if (a.kind === "text" && b.kind === "text") return a.text === b.text;
  return false;
}

/** Structural equality of tracks and primaryVideoClipId; assets excluded. */
export function timelinesEquivalent(a: Timeline, b: Timeline): boolean {
  if (a.primaryVideoClipId !== b.primaryVideoClipId || a.tracks.length !== b.tracks.length) return false;
  return a.tracks.every((track, i) => {
    const other = b.tracks[i];
    if (track.id !== other.id || track.kind !== other.kind) return false;
    if (!trackExtraEquivalent(track, other)) return false;
    if (track.clips.length !== other.clips.length) return false;
    return track.clips.every((clip, j) => clipsEquivalent(clip as Clip, other.clips[j] as Clip));
  });
}

export const emptyJournal = (): SnapshotJournal => ({ past: [], future: [], open: null });

/** Closed edit: push {before, after}, drop the future branch, evict past beyond the cap. */
export function registerEdit(
  journal: SnapshotJournal,
  before: Timeline,
  after: Timeline
): SnapshotJournal {
  const past = [...journal.past, { before, after }];
  return { past: past.length > CAP ? past.slice(-CAP) : past, future: [], open: journal.open };
}

/** Open a transaction (drag bracket or text burst); replaces any open one. */
export function openTransaction(
  journal: SnapshotJournal,
  open: OpenTransaction
): SnapshotJournal {
  return { ...journal, open };
}

/** Close the open transaction against current: an equivalent endpoint
 * (net-zero gesture) records nothing, a changed one lands as one entry. */
export function settleTransaction(journal: SnapshotJournal, current: Timeline): SnapshotJournal {
  const open = journal.open;
  if (!open) return journal;
  if (timelinesEquivalent(open.before, current)) return { ...journal, open: null };
  return { ...registerEdit(journal, open.before, current), open: null };
}

/** Undo target: null on an empty past. Moves the top entry to the future and
 * clears any open transaction, whose baseline is now stale. */
export function undoStep(
  journal: SnapshotJournal
): { journal: SnapshotJournal; timeline: Timeline } | null {
  const entry = journal.past[journal.past.length - 1];
  if (!entry) return null;
  return {
    journal: { past: journal.past.slice(0, -1), future: [entry, ...journal.future], open: null },
    timeline: entry.before,
  };
}

/** Redo target: null on an empty future. Moves the top entry back to past. */
export function redoStep(
  journal: SnapshotJournal
): { journal: SnapshotJournal; timeline: Timeline } | null {
  const entry = journal.future[0];
  if (!entry) return null;
  return {
    journal: { past: [...journal.past, entry], future: journal.future.slice(1), open: null },
    timeline: entry.after,
  };
}

/** True while a text burst is open (the undo settles and takes it), false while
 * a drag is open, else past.length > 0. Mirrors the UNDO event's behavior. */
export const canUndo = (journal: SnapshotJournal): boolean =>
  journal.open ? journal.open.kind !== "drag" : journal.past.length > 0;

/** False while a drag is open, else future.length > 0. Mirrors REDO. */
export const canRedo = (journal: SnapshotJournal): boolean =>
  journal.open?.kind === "drag" ? false : journal.future.length > 0;