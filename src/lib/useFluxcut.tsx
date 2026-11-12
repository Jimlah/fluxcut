import { useMemo, type ReactNode } from "react";
import { createActorContext } from "@xstate/react";
import type { ActorRefFrom, SnapshotFrom } from "xstate";
import { fluxcutMachine, statusOf } from "./machine";
import type { FluxcutContext as FluxcutMachineContext, FluxcutStatus } from "./machine";
import { RESOLUTIONS } from "./convert";
import { aspectLabel, fmtBytes, fmtTime } from "./video";

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

      // ---- playback (acts on the machine-owned video element) ----
      play: () => send({ type: "PLAY" }),
      pause: () => send({ type: "PAUSE" }),
      togglePlay: () => send({ type: "TOGGLE_PLAY" }),
      seek: (time: number) => send({ type: "SEEK", time }),
      seekBy: (delta: number) => send({ type: "SEEK_BY", delta }),

      // ---- element lifecycle ----
      attachVideo: (element: HTMLVideoElement) => send({ type: "ATTACH_VIDEO", element }),
      detachVideo: () => send({ type: "DETACH_VIDEO" }),
      attachInput: (element: HTMLInputElement) => send({ type: "ATTACH_INPUT", element }),
      attachStrip: (element: HTMLDivElement) => send({ type: "ATTACH_STRIP", element }),
      detachStrip: () => send({ type: "DETACH_STRIP" }),

      // ---- timeline ----
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

/** True while any blocking workflow is active (fetching/inspecting/converting). */
export function useFluxcutBusy(): boolean {
  return useFluxcutSelector((s) => {
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
  ticks: string[];
}

const VIEW_MBPS: Record<string, number> = { "1080": 8, "720": 5, "480": 2.5, "360": 1.2 };

/** One selector that formats everything the UI renders as text. */
export function selectView(s: FluxcutSnapshot): FluxcutView {
  const c = s.context;
  const dur = c.meta.duration;
  const trimLen = Math.max(0, c.trim.end - c.trim.start);
  const eff = trimLen || dur;
  const q = c.qualityId === "high" ? 1 : c.qualityId === "medium" ? 0.6 : 0.35;

  const ticks: string[] = [];
  if (dur > 0) {
    const raw = dur / 12;
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300];
    const step = steps.find((x) => x >= raw) ?? 600;
    for (let t = 0; t <= dur + 0.01; t += step) ticks.push(fmtTime(t));
  }

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
    ticks,
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

/* ---------- timeline view: geometry + mode, pre-computed ---------- */

// Demo stills fetched from Mixkit (see README credits)
export const DEMO_THUMBS = [
  "https://assets.mixkit.co/videos/4188/4188-thumb-360-0.jpg", // festival stage (blue/purple)
  "https://assets.mixkit.co/videos/31469/31469-thumb-360-3.jpg", // blue/red water spray
  "https://assets.mixkit.co/videos/1834/1834-thumb-360-1.jpg", // multicolor space smoke
  "https://assets.mixkit.co/videos/46317/46317-thumb-360-3.jpg", // golden glitter
  "https://assets.mixkit.co/videos/3460/3460-thumb-360-0.jpg", // fire particles
  "https://assets.mixkit.co/videos/45597/45597-thumb-360-3.jpg", // red smoke on black
];

export interface TimelineView {
  mode: "demo" | "live" | "empty";
  frames: string[];
  ticks: string[];
  timeText: string;
  playheadPct: number;
  trimActive: boolean;
  trimLeftPct: number;
  trimWidthPct: number;
  trimInPct: number;
  trimOutPct: number;
}

/** A dedicated selector so Timeline re-renders without touching global view. */
export function selectTimelineView(s: FluxcutSnapshot): TimelineView {
  const c = s.context;
  const dur = c.meta.duration || 0;
  const demo = !c.fileUrl;
  const live = !demo && dur > 0;
  const mode: TimelineView["mode"] = live ? "live" : demo ? "demo" : "empty";
  const pct = dur ? (t: number) => (Math.min(1, Math.max(0, t / dur)) * 100) : () => 0;

  const frames = live
    ? c.frames.length
      ? c.frames
      : c.meta.poster
        ? [c.meta.poster]
        : []
    : DEMO_THUMBS;

  return {
    mode,
    frames,
    ticks: live ? selectView(s).ticks : [],
    timeText: fmtTime(c.time),
    playheadPct: live ? pct(c.time) : 0,
    trimActive: live && (c.trim.start > 0.05 || c.trim.end < dur - 0.05),
    trimLeftPct: pct(c.trim.start),
    trimWidthPct: dur ? pct(c.trim.end - c.trim.start) - pct(c.trim.start) : 0,
    trimInPct: pct(c.trim.start),
    trimOutPct: pct(c.trim.end),
  };
}

/** Timeline-specific subscription — isolates its high-frequency updates. */
export function useTimelineView(): TimelineView {
  return useFluxcutSelector(selectTimelineView, shallowEqual);
}