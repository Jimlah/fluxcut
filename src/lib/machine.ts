// Fluxcut statechart — modeled with XState v5 (Stately)
// https://stately.ai/docs
//
// empty ──LOAD_FILE──▶ loading ──done──▶ ready ──CONVERT──▶ converting ──▶ done
//   ▲                    │               ▲   ▲                │          │
//   └──────CLEAR─────────┘               │   └──CANCEL───────┘          │
//                                       └─────AGAIN / settings─────────┘
//
// Global actors (invoked at machine root, alive for the machine's lifetime):
//   - dragDropActor : window drag & drop → DRAG_OVER / DROP_FILE
//   - clockActor    : rAF composition clock → TIMELINE_TICK(dt)
//   - clipDragActor : clip drag/resize pointer capture → CLIP_DRAG_MOVE/END
// The machine owns composition time: context.time advances through the clock
// actor and media elements are nudged toward it — no element reports time back.
import { setup, assign, fromPromise, fromCallback, raise, sendTo } from "xstate";
import type { Conversion } from "mediabunny";
import { runConversion, probeSupportedFormats } from "./convert";
import { captureFilmstrip } from "./video";
import type { FileMeta, ResultInfo, TrimRange } from "./types";
import {
  EMPTY_TIMELINE,
  MIN_CLIP_SEC,
  addMediaClip,
  addTextClip,
  addTrack,
  bootstrapMainVideo,
  compToSource,
  compositionEnd,
  deleteClip,
  findClip,
  findTrack,
  moveTrack,
  newAssetId,
  planClipDrag,
  removeTrack,
  setClipText,
  type Asset,
  type ClipDragMode,
  type ClipId,
  type Timeline,
  type TrackId,
  type TrackKind,
} from "./timeline";

/* ---------- actor payloads ---------- */

export interface LoadOutput {
  fileUrl: string;
  meta: FileMeta;
  frames: string[];
}

export interface ConvertInput {
  file: File;
  meta: FileMeta;
  trim: TrimRange;
  formatId: string;
  resId: string;
  qualityId: string;
}

/* ---------- events ---------- */

export type ConvertSentEvent =
  | { type: "CONVERT_PROGRESS"; progress: number }
  | { type: "CONVERT_HANDLE"; conversion: Conversion }
  | { type: "CONVERT_NOTE"; note: string }
  | { type: "CONVERT_DONE"; result: ResultInfo }
  | { type: "CONVERT_ERROR"; error: unknown };

export type FluxcutEvent =
  | { type: "LOAD_FILE"; file: File }
  | { type: "LOAD_URL"; url: string }
  | { type: "CLEAR" }
  | { type: "SET_FORMAT"; id: string }
  | { type: "SET_RES"; id: string }
  | { type: "SET_QUALITY"; id: string }
  | { type: "SET_TRIM"; trim: TrimRange }
  | { type: "RESET_TRIM" }
  | { type: "SET_IN_POINT" }
  | { type: "SET_OUT_POINT" }
  | { type: "CONVERT" }
  | { type: "CANCEL" }
  | { type: "AGAIN" }
  | { type: "TOGGLE_GRID" }
  | { type: "DRAG_OVER"; over: boolean }
  | { type: "DROP_FILE"; file: File }
  | { type: "ATTACH_INPUT"; element: HTMLInputElement }
  | { type: "ATTACH_STRIP"; element: HTMLDivElement }
  | { type: "DETACH_STRIP" }
  | { type: "DRAG_STRIP"; clientX: number }
  | { type: "STRIP_SEEK"; pct: number }
  | { type: "PLAY" }
  | { type: "PAUSE" }
  | { type: "TOGGLE_PLAY" }
  | { type: "SEEK"; time: number }
  | { type: "SEEK_BY"; delta: number }
  | { type: "TIMELINE_TICK"; dt: number }
  | { type: "ADD_TRACK"; kind: TrackKind }
  | { type: "REMOVE_TRACK"; trackId: TrackId }
  | { type: "MOVE_TRACK"; trackId: TrackId; dir: -1 | 1 }
  | { type: "ADD_TEXT_CLIP"; trackId: TrackId }
  | { type: "SET_CLIP_TEXT"; clipId: ClipId; text: string }
  | { type: "SELECT_CLIP"; clipId: ClipId | null }
  | { type: "CLIP_DELETE"; clipId: ClipId }
  | {
      type: "CLIP_DRAG_START";
      clipId: ClipId;
      mode: ClipDragMode;
      time: number;
      element: HTMLDivElement;
      seconds: number;
    }
  | { type: "CLIP_DRAG_MOVE"; time: number }
  | { type: "CLIP_DRAG_END" }
  | { type: "REQUEST_PICK_FILE" }
  | { type: "REQUEST_PICK_TRACK_MEDIA"; trackId: TrackId }
  | { type: "ADD_MEDIA_CLIP"; trackId: TrackId; file: File }
  | { type: "SET_PROJECT_NAME"; name: string }
  | { type: "SET_PANEL_OPEN"; open: boolean }
  | { type: "TOGGLE_PANEL" }
  | { type: "SET_TOOL"; tool: string }
  | { type: "SET_CAPABILITIES"; formats: string[] }
  | ConvertSentEvent;

/* ---------- context ---------- */

export interface FluxcutContext {
  file: File | null;
  fileUrl: string | null;
  meta: FileMeta;
  frames: string[];
  trim: TrimRange;
  formatId: string;
  resId: string;
  qualityId: string;
  progress: number;
  engineNote: string;
  error: string;
  result: ResultInfo | null;
  handle: Conversion | null;
  /** Machine-owned composition clock — never read from a media element. */
  time: number;
  playing: boolean;
  gridOn: boolean;
  dragOver: boolean;
  /** Multi-track project state (assets + ordered tracks), see lib/timeline.ts */
  timeline: Timeline;
  selectedClipId: ClipId | null;
  /** Live clip drag; anchorTime is the last accepted pointer time. */
  drag: { clipId: ClipId; mode: ClipDragMode; anchorTime: number } | null;
  /** Timeline ruler element — attached from the Timeline component */
  stripEl: HTMLDivElement | null;
  /** Hidden file input element — attached from the FilePicker component */
  fileInput: HTMLInputElement | null;
  /** Track targeted by a track-media pick; null means the main video. */
  pickTarget: TrackId | null;
  /** accept attribute for the pending pick */
  pickAccept: string;
  /** URL being fetched for a remote-video load */
  pendingUrl: string | null;
  projectName: string;
  panelOpen: boolean;
  activeTool: string;
  /** Output format ids this browser can encode (mp4/webm/mov/mkv) */
  supportedFormats: string[];
  /** False until the capability probe has reported */
  capsProbed: boolean;
}

const DEFAULT_VIDEO_ACCEPT = "video/*,.mkv,.ts,.m4v";

function trackAccept(kind: TrackKind | undefined): string {
  if (kind === "audio") return "audio/*";
  if (kind === "image") return "image/*";
  return DEFAULT_VIDEO_ACCEPT;
}

const defaultContext: FluxcutContext = {
  file: null,
  fileUrl: null,
  meta: { duration: 0, w: 0, h: 0, poster: "" },
  frames: [],
  trim: { start: 0, end: 0 },
  formatId: "mp4",
  resId: "720",
  qualityId: "medium",
  progress: 0,
  engineNote: "",
  error: "",
  result: null,
  handle: null,
  time: 0,
  playing: false,
  gridOn: false,
  dragOver: false,
  timeline: EMPTY_TIMELINE,
  selectedClipId: null,
  drag: null,
  stripEl: null,
  fileInput: null,
  pickTarget: null,
  pickAccept: DEFAULT_VIDEO_ACCEPT,
  pendingUrl: null,
  projectName: "Untitled conversion",
  panelOpen: true,
  activeTool: "clip",
  supportedFormats: [],
  capsProbed: false,
};

/* ---------- actions helpers ---------- */

/** Adopts a projected timeline (or keeps the old one) and drops dead selections. */
function resolveTimeline(context: FluxcutContext, next: Timeline | null): Partial<FluxcutContext> {
  if (!next) return {};
  return {
    timeline: next,
    selectedClipId:
      context.selectedClipId && findClip(next, context.selectedClipId)
        ? context.selectedClipId
        : null,
  };
}

/* ---------- actors ---------- */

// Inspect + filmstrip a freshly picked file, off the main stage video.
const loadVideoMeta = fromPromise<LoadOutput, { file: File }>(async ({ input }) => {
  const { file } = input;
  const fileUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.src = fileUrl;
  await new Promise<void>((resolve, reject) => {
    video.addEventListener("loadedmetadata", () => resolve(), { once: true });
    video.addEventListener(
      "error",
      () => reject(new Error("Couldn't decode this file in your browser.")),
      { once: true }
    );
  });
  const meta: FileMeta = {
    duration: video.duration || 0,
    w: video.videoWidth,
    h: video.videoHeight,
    poster: "",
  };
  const frames = await captureFilmstrip(video, 10);
  if (frames[0]) meta.poster = frames[0];
  // release the decoder
  video.removeAttribute("src");
  video.load();
  return { fileUrl, meta, frames };
});

// Reads any media file into a timeline Asset; the target trackId rides on the
// output so the caller can place the clip when the probe lands.
const probeMedia = fromPromise<{ asset: Asset; trackId: TrackId }, { file: File; trackId: TrackId }>(
  async ({ input }) => {
    const { file, trackId } = input;
    const isVideo = file.type.startsWith("video/") || /\.(mkv|ts|m4v)$/i.test(file.name);
    const isAudio = file.type.startsWith("audio/");
    const isImage = file.type.startsWith("image/");
    if (!isVideo && !isAudio && !isImage) throw new Error("Unsupported file type.");
    const url = URL.createObjectURL(file);
    if (isImage) {
      const img = new Image();
      img.src = url;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Couldn't decode this image."));
      });
      return {
        trackId,
        asset: {
          id: newAssetId(),
          kind: "image",
          name: file.name,
          url,
          w: img.naturalWidth,
          h: img.naturalHeight,
        },
      };
    }
    if (isAudio) {
      const audio = document.createElement("audio");
      audio.preload = "metadata";
      audio.src = url;
      const duration = await new Promise<number>((resolve, reject) => {
        audio.addEventListener("loadedmetadata", () => resolve(audio.duration || 0), { once: true });
        audio.addEventListener(
          "error",
          () => reject(new Error("Couldn't decode this audio file.")),
          { once: true }
        );
      });
      return { trackId, asset: { id: newAssetId(), kind: "audio", name: file.name, url, duration } };
    }
    // Same decode + filmstrip pass as the main-file probe
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.addEventListener("loadedmetadata", () => resolve(), { once: true });
      video.addEventListener(
        "error",
        () => reject(new Error("Couldn't decode this file in your browser.")),
        { once: true }
      );
    });
    // Snapshot the media facts BEFORE releasing the decoder — after
    // removeAttribute("src") the element reports duration/size as 0/NaN.
    const duration = video.duration || 0;
    const w = video.videoWidth;
    const h = video.videoHeight;
    const frames = await captureFilmstrip(video, 10);
    video.removeAttribute("src");
    video.load();
    return {
      trackId,
      asset: {
        id: newAssetId(),
        kind: "video",
        name: file.name,
        url,
        duration,
        w,
        h,
        poster: frames[0] ?? "",
        frames,
      },
    };
  }
);

// Downloads a remote video as a Blob and hands it over as a File so it can
// flow through the normal LOAD_FILE pipeline. Subject to CORS like any fetch.
const fetchVideo = fromPromise<File, { url: string }>(async ({ input }) => {
  const res = await fetch(input.url);
  if (!res.ok) throw new Error(`Couldn't download (HTTP ${res.status})`);
  const blob = await res.blob();
  if (!blob.size) throw new Error("The URL returned an empty response.");
  const seg = input.url.split("?")[0].split("#")[0].split("/").pop() || "video";
  const name = decodeURIComponent(seg) || "video";
  return new File([blob], name, { type: blob.type || "video/mp4" });
});

// Streams progress / encoder handle / notes back to the machine while the
// mediabunny conversion runs. Done + error arrive as sent events too.
const convertActor = fromCallback<ConvertSentEvent, ConvertInput>(
  ({ input, sendBack }) => {
    const { file, meta, trim, formatId, resId, qualityId } = input;
    runConversion({
      file,
      srcW: meta.w,
      srcH: meta.h,
      duration: meta.duration,
      formatId,
      resId,
      qualityId,
      trim,
      onProgress: (progress) => sendBack({ type: "CONVERT_PROGRESS", progress }),
      onCodec: (codec) =>
        sendBack({ type: "CONVERT_NOTE", note: `Encoding with ${codec.toUpperCase()}` }),
      onConversion: (conversion) => sendBack({ type: "CONVERT_HANDLE", conversion }),
    })
      .then((res) =>
        sendBack({
          type: "CONVERT_DONE",
          result: {
            name: res.name,
            size: res.size,
            codec: res.codec,
            dims: res.dims,
            url: URL.createObjectURL(res.blob),
          },
        })
      )
      .catch((error) => sendBack({ type: "CONVERT_ERROR", error }));
    // Run until the parent leaves the invoking state (stop discards this actor).
    return () => {};
  }
);

// Window-level drag & drop → DRAG_OVER / DROP_FILE for the machine's lifetime.
const dragDropActor = fromCallback<
  { type: "DRAG_OVER"; over: boolean } | { type: "DROP_FILE"; file: File }
>(({ sendBack }) => {
  const over = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer?.types?.includes("Files")) {
      sendBack({ type: "DRAG_OVER", over: true });
    }
  };
  const leave = (e: DragEvent) => {
    if (e.relatedTarget === null) sendBack({ type: "DRAG_OVER", over: false });
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    sendBack({ type: "DRAG_OVER", over: false });
    const f = e.dataTransfer?.files?.[0];
    if (f) sendBack({ type: "DROP_FILE", file: f });
  };
  window.addEventListener("dragover", over);
  window.addEventListener("dragleave", leave);
  window.addEventListener("drop", drop);
  return () => {
    window.removeEventListener("dragover", over);
    window.removeEventListener("dragleave", leave);
    window.removeEventListener("drop", drop);
  };
});

// Keyboard shortcuts: space = play/pause, ←/→ (±shift) = seek by seconds.
// Input fields and buttons are skipped so typing/space-activation still works.
const keyboardActor = fromCallback<FluxcutEvent>(({ sendBack }) => {
  const onKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON" || tag === "SELECT") return;
    if (e.code === "Space") {
      e.preventDefault();
      sendBack({ type: "TOGGLE_PLAY" });
    }
    if (e.key === "ArrowRight") sendBack({ type: "SEEK_BY", delta: e.shiftKey ? 5 : 1 });
    if (e.key === "ArrowLeft") sendBack({ type: "SEEK_BY", delta: e.shiftKey ? -5 : -1 });
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
});

// Composition clock: rAF ticks while started; the machine folds each dt into
// context.time (looping at compositionEnd). No media element reports time back.
const clockActor = fromCallback<{ type: "CLOCK_START" } | { type: "CLOCK_STOP" }, undefined, { type: "TIMELINE_TICK"; dt: number }>(
  ({ sendBack, receive }) => {
    let raf = 0;
    let last = 0;
    const loop = (now: number) => {
      sendBack({ type: "TIMELINE_TICK", dt: Math.min(1, (now - last) / 1000) });
      last = now;
      raf = requestAnimationFrame(loop);
    };
    const start = () => {
      if (raf) return;
      last = performance.now();
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (!raf) return;
      cancelAnimationFrame(raf);
      raf = 0;
    };
    receive((event) => {
      if (event.type === "CLOCK_START") start();
      if (event.type === "CLOCK_STOP") stop();
    });
    return () => stop();
  }
);

// Clip drag/resize capture: React reports the row element once; this actor
// streams pointer position as composition time until pointerup.
type ClipDragSent = { type: "CLIP_DRAG_MOVE"; time: number } | { type: "CLIP_DRAG_END" };
const clipDragActor = fromCallback<
  { type: "START"; element: HTMLDivElement; seconds: number },
  undefined,
  ClipDragSent
>(({ sendBack, receive }) => {
  let cleanup: (() => void) | null = null;

  receive((event) => {
    if (event.type !== "START" || !event.element) return;
    if (cleanup) cleanup();
    const rect = event.element.getBoundingClientRect();
    const timeOf = (clientX: number) => {
      const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return pct * event.seconds;
    };
    const move = (ev: PointerEvent) => {
      sendBack({ type: "CLIP_DRAG_MOVE", time: timeOf(ev.clientX) });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      cleanup = null;
      sendBack({ type: "CLIP_DRAG_END" });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  });

  return () => {
    if (cleanup) cleanup();
  };
});

// Probes WebCodecs support for each output format once at startup and
// reports the result so the UI can enable/disable format chips accordingly.
const capsActor = fromCallback<{ type: "SET_CAPABILITIES"; formats: string[] }>(
  ({ sendBack }) => {
    probeSupportedFormats()
      .then((formats) => sendBack({ type: "SET_CAPABILITIES", formats }))
      .catch(() => sendBack({ type: "SET_CAPABILITIES", formats: ["mp4"] }));
    return () => {};
  }
);

// Ruler playhead dragging. React only reports the pointer-down X; this actor
// owns the capture, computes the percentage from the ruler rect, and streams
// STRIP_SEEK back on every move. Cleaned up on pointerup.
type StripDragEvent =
  | { type: "ATTACH"; element: HTMLDivElement }
  | { type: "START"; element: HTMLDivElement; clientX: number };

const stripDragActor = fromCallback<
  StripDragEvent,
  undefined,
  { type: "STRIP_SEEK"; pct: number }
>(({ sendBack, receive }) => {
    let cleanup: (() => void) | null = null;

    receive((event) => {
      if (event.type !== "START" || !event.element) return;
      if (cleanup) cleanup();
      const rect = event.element.getBoundingClientRect();
      const pctOf = (x: number) =>
        Math.min(1, Math.max(0, (x - rect.left) / rect.width));

      const move = (ev: PointerEvent) => {
        sendBack({ type: "STRIP_SEEK", pct: pctOf(ev.clientX) });
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        cleanup = null;
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      cleanup = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      // Seek immediately on pointer-down
      sendBack({ type: "STRIP_SEEK", pct: pctOf(event.clientX) });
    });

    return () => {
      if (cleanup) cleanup();
    };
  }
);

/* ---------- machine ---------- */

export const fluxcutMachine = setup({
  types: {
    context: {} as FluxcutContext,
    events: {} as FluxcutEvent,
    input: undefined as undefined,
  },
  actors: {
    loadVideoMeta,
    probeMedia,
    convertActor,
    dragDropActor,
    clockActor,
    keyboardActor,
    capsActor,
    stripDragActor,
    clipDragActor,
    fetchVideo,
  },
  actions: {
    revokeResult: ({ context }) => {
      if (context.result) URL.revokeObjectURL(context.result.url);
    },
    revokeFileUrl: ({ context }) => {
      if (context.fileUrl) URL.revokeObjectURL(context.fileUrl);
    },
    stopClock: sendTo("clock", { type: "CLOCK_STOP" }),
    resetFile: assign({
      file: null,
      fileUrl: null,
      frames: [],
      meta: { duration: 0, w: 0, h: 0, poster: "" },
      trim: { start: 0, end: 0 },
      progress: 0,
      engineNote: "",
      error: "",
      result: null,
      handle: null,
      time: 0,
      playing: false,
      gridOn: false,
      dragOver: false,
      pendingUrl: null,
      timeline: EMPTY_TIMELINE,
      selectedClipId: null,
      drag: null,
      pickTarget: null,
      pickAccept: DEFAULT_VIDEO_ACCEPT,
    }),
  },
}).createMachine({
  id: "fluxcut",
  initial: "empty",
  context: defaultContext,
  // Global actors — alive for the machine's entire lifetime
  invoke: [
    { src: "dragDropActor" },
    { src: "clockActor", id: "clock" },
    { src: "keyboardActor" },
    { src: "capsActor" },
    { src: "stripDragActor", id: "stripDrag" },
    { src: "clipDragActor", id: "clipDrag" },
  ],
  // Global, state-independent reactions
  on: {
    // A dropped file is simply a LOAD_FILE; in loading/converting states the
    // raised event is ignored by the statechart on its own terms.
    DROP_FILE: {
      actions: raise(({ event }) => {
        const dropFile = event as Extract<FluxcutEvent, { type: "DROP_FILE" }>;
        return { type: "LOAD_FILE", file: dropFile.file };
      }),
    },
    TOGGLE_GRID: {
      actions: assign({ gridOn: ({ context }) => !context.gridOn }),
    },
    // Guarded so a flood of dragover events doesn't spam re-renders
    DRAG_OVER: {
      guard: ({ context, event }) => context.dragOver !== event.over,
      actions: assign({ dragOver: ({ event }) => event.over }),
    },
    // ---- composition clock: the machine owns time ----
    PLAY: {
      guard: ({ context }) => compositionEnd(context.timeline) > 0,
      actions: [assign({ playing: true }), sendTo("clock", { type: "CLOCK_START" })],
    },
    PAUSE: {
      actions: [assign({ playing: false }), sendTo("clock", { type: "CLOCK_STOP" })],
    },
    TOGGLE_PLAY: {
      actions: raise(({ context }) => ({
        type: context.playing ? ("PAUSE" as const) : ("PLAY" as const),
      })),
    },
    SEEK: {
      actions: assign({
        time: ({ context, event }) =>
          Math.max(0, Math.min(event.time, Math.max(0, compositionEnd(context.timeline) - 0.05))),
      }),
    },
    SEEK_BY: {
      actions: assign({
        time: ({ context, event }) =>
          Math.max(
            0,
            Math.min(context.time + event.delta, Math.max(0, compositionEnd(context.timeline) - 0.05))
          ),
      }),
    },
    STRIP_SEEK: {
      actions: raise(({ context, event }) => ({
        type: "SEEK",
        time: event.pct * compositionEnd(context.timeline),
      })),
    },
    TIMELINE_TICK: [
      // All clips gone while playing → stop instead of looping on a 0s clock
      {
        guard: ({ context }) => context.playing && compositionEnd(context.timeline) <= 0,
        actions: raise({ type: "PAUSE" }),
      },
      {
        guard: ({ context }) => context.playing,
        actions: assign(({ context, event }) => {
          const end = compositionEnd(context.timeline);
          return { time: end > 0 ? (context.time + event.dt) % end : 0 };
        }),
      },
    ],
    // ---- timeline strip lifecycle + ruler dragging ----
    ATTACH_STRIP: {
      actions: [
        assign({ stripEl: ({ event }) => event.element }),
        sendTo("stripDrag", ({ event }) => ({ type: "ATTACH", element: event.element })),
      ],
    },
    DETACH_STRIP: {
      actions: assign({ stripEl: null }),
    },
    DRAG_STRIP: {
      actions: sendTo("stripDrag", ({ context, event }) => ({
        type: "START",
        element: context.stripEl!,
        clientX: event.clientX,
      })),
    },
    ATTACH_INPUT: {
      actions: assign({ fileInput: ({ event }) => event.element }),
    },
    // ---- track + clip edits: helpers return null → keep previous state ----
    ADD_TRACK: {
      actions: assign({ timeline: ({ context, event }) => addTrack(context.timeline, event.kind) }),
    },
    REMOVE_TRACK: {
      actions: assign(({ context, event }) =>
        resolveTimeline(context, removeTrack(context.timeline, event.trackId))
      ),
    },
    MOVE_TRACK: {
      actions: assign(({ context, event }) =>
        resolveTimeline(context, moveTrack(context.timeline, event.trackId, event.dir))
      ),
    },
    ADD_TEXT_CLIP: {
      actions: assign(({ context, event }) => {
        const placed = addTextClip(context.timeline, event.trackId, context.time);
        return placed ? { timeline: placed.timeline, selectedClipId: placed.clipId } : {};
      }),
    },
    SET_CLIP_TEXT: {
      actions: assign(({ context, event }) =>
        resolveTimeline(context, setClipText(context.timeline, event.clipId, event.text))
      ),
    },
    CLIP_DELETE: {
      actions: assign(({ context, event }) =>
        resolveTimeline(context, deleteClip(context.timeline, event.clipId))
      ),
    },
    SELECT_CLIP: {
      guard: ({ context, event }) => event.clipId == null || !!findClip(context.timeline, event.clipId),
      actions: assign({ selectedClipId: ({ event }) => event.clipId }),
    },
    CLIP_DRAG_START: {
      actions: [
        assign({
          drag: ({ event }) => ({
            clipId: event.clipId,
            mode: event.mode,
            anchorTime: event.time,
          }),
          selectedClipId: ({ event }) => event.clipId,
        }),
        sendTo("clipDrag", ({ event }) => ({
          type: "START",
          element: event.element,
          seconds: event.seconds,
        })),
      ],
    },
    CLIP_DRAG_MOVE: {
      actions: assign(({ context, event }) => {
        if (!context.drag) return {};
        const next = planClipDrag(context.timeline, context.drag, event.time);
        // Anchor advances only on accepted moves, so rejects never accumulate
        return next ? { timeline: next, drag: { ...context.drag, anchorTime: event.time } } : {};
      }),
    },
    CLIP_DRAG_END: {
      actions: assign({ drag: null }),
    },
    // ---- media ingest for tracks ----
    REQUEST_PICK_TRACK_MEDIA: {
      actions: [
        ({ context }) => {
          context.fileInput?.click();
        },
        assign(({ context, event }) => ({
          pickTarget: event.trackId,
          pickAccept: trackAccept(findTrack(context.timeline, event.trackId)?.kind),
        })),
      ],
    },
    // ---- chrome ----
    SET_PROJECT_NAME: {
      actions: assign({ projectName: ({ event }) => event.name }),
    },
    SET_PANEL_OPEN: {
      actions: assign({ panelOpen: ({ event }) => event.open }),
    },
    TOGGLE_PANEL: {
      actions: assign({ panelOpen: ({ context }) => !context.panelOpen }),
    },
    SET_TOOL: {
      actions: assign({
        activeTool: ({ context, event }) =>
          context.activeTool === event.tool ? "" : event.tool,
      }),
    },
    SET_CAPABILITIES: {
      actions: assign(({ context, event }) => {
        const keep = event.formats.includes(context.formatId);
        return {
          capsProbed: true,
          supportedFormats: event.formats,
          // If the selected format turned out unsupported, fall back to the
          // first supported one (probing order: mp4, webm, mov, mkv).
          formatId: keep ? context.formatId : (event.formats[0] ?? context.formatId),
        };
      }),
    },
    REQUEST_PICK_FILE: {
      actions: [
        ({ context }) => {
          context.fileInput?.click();
        },
        // Opening the picker implies wanting to see the convert panel again
        assign({ panelOpen: true, pickTarget: null, pickAccept: DEFAULT_VIDEO_ACCEPT }),
      ],
    },
  },
  states: {
    empty: {
      on: {
        LOAD_FILE: {
          target: "loading",
          actions: assign({ file: ({ event }) => event.file, error: "" }),
        },
        LOAD_URL: {
          target: "downloading",
          actions: assign({ pendingUrl: ({ event }) => event.url, error: "" }),
        },
      },
    },

    loading: {
      tags: "loading",
      invoke: {
        src: "loadVideoMeta",
        input: ({ context }) => ({ file: context.file! }),
        onDone: {
          target: "ready",
          actions: assign({
            fileUrl: ({ event }) => event.output.fileUrl,
            meta: ({ event }) => event.output.meta,
            frames: ({ event }) => event.output.frames,
            trim: ({ event }) => ({ start: 0, end: event.output.meta.duration }),
            time: 0,
            playing: false,
            timeline: ({ context, event }) =>
              bootstrapMainVideo(EMPTY_TIMELINE, {
                url: event.output.fileUrl,
                duration: event.output.meta.duration,
                w: event.output.meta.w,
                h: event.output.meta.h,
                poster: event.output.meta.poster,
                frames: event.output.frames,
                name: context.file?.name ?? "Main video",
              }),
            selectedClipId: null,
            drag: null,
          }),
        },
        onError: {
          target: "empty",
          actions: [
            "resetFile",
            assign({
              error: ({ event }) =>
                event.error instanceof Error ? event.error.message : "Couldn't load that file.",
            }),
          ],
        },
      },
      on: {
        LOAD_FILE: {
          target: "loading",
          actions: assign({ file: ({ event }) => event.file, error: "" }),
        },
        LOAD_URL: {
          target: "downloading",
          actions: assign({ pendingUrl: ({ event }) => event.url, error: "" }),
        },
        CLEAR: { target: "empty", actions: ["resetFile"] },
      },
    },

    downloading: {
      tags: "downloading",
      invoke: {
        src: "fetchVideo",
        input: ({ context }) => ({ url: context.pendingUrl! }),
        onDone: {
          target: "loading",
          actions: assign({
            file: ({ event }) => event.output,
            pendingUrl: null,
          }),
        },
        onError: {
          target: "empty",
          actions: [
            "resetFile",
            assign({
              error: ({ event }) =>
                event.error instanceof Error ? event.error.message : "Couldn't download that URL.",
            }),
          ],
        },
      },
      on: {
        LOAD_URL: {
          target: "downloading",
          actions: assign({ pendingUrl: ({ event }) => event.url, error: "" }),
        },
        CLEAR: { target: "empty", actions: ["resetFile"] },
      },
    },

    ready: {
      on: {
        SET_FORMAT: { actions: assign({ formatId: ({ event }) => event.id }) },
        SET_RES: { actions: assign({ resId: ({ event }) => event.id }) },
        SET_QUALITY: { actions: assign({ qualityId: ({ event }) => event.id }) },
        SET_TRIM: { actions: assign({ trim: ({ event }) => event.trim }) },
        RESET_TRIM: {
          actions: assign({
            trim: ({ context }) => ({ start: 0, end: context.meta.duration || 0 }),
          }),
        },
        // In/Out project the playhead into SOURCE seconds of the main clip;
        // off the main clip the previous trim stays (buttons disabled in UI).
        SET_IN_POINT: {
          actions: assign(({ context }) => {
            const src = compToSource(context.timeline, context.time);
            if (src == null) return {};
            return {
              trim: {
                start: Math.min(src, context.trim.end - MIN_CLIP_SEC),
                end: context.trim.end,
              },
            };
          }),
        },
        SET_OUT_POINT: {
          actions: assign(({ context }) => {
            const src = compToSource(context.timeline, context.time);
            if (src == null) return {};
            return {
              trim: {
                start: context.trim.start,
                end: Math.max(src, context.trim.start + MIN_CLIP_SEC),
              },
            };
          }),
        },
        CONVERT: {
          target: "converting",
          actions: assign({ panelOpen: true }),
        },
        ADD_MEDIA_CLIP: {
          target: "#fluxcut.addingClip",
          guard: ({ context }) => context.pickTarget != null,
        },
        LOAD_FILE: {
          target: "loading",
          actions: [
            "revokeFileUrl",
            "stopClock",
            assign({
              file: ({ event }) => event.file,
              error: "",
              result: null,
              progress: 0,
              time: 0,
              playing: false,
              timeline: EMPTY_TIMELINE,
              selectedClipId: null,
              drag: null,
            }),
          ],
        },
        LOAD_URL: {
          target: "downloading",
          actions: [
            "revokeFileUrl",
            "revokeResult",
            assign({ pendingUrl: ({ event }) => event.url, error: "", progress: 0 }),
          ],
        },
        CLEAR: { target: "empty", actions: ["revokeFileUrl", "resetFile", "stopClock"] },
      },
    },

    converting: {
      tags: "converting",
      invoke: {
        src: "convertActor",
        input: ({ context }) => ({
          file: context.file!,
          meta: context.meta,
          trim: context.trim,
          formatId: context.formatId,
          resId: context.resId,
          qualityId: context.qualityId,
        }),
      },
      on: {
        CONVERT_PROGRESS: { actions: assign({ progress: ({ event }) => event.progress }) },
        CONVERT_HANDLE: { actions: assign({ handle: ({ event }) => event.conversion }) },
        CONVERT_NOTE: { actions: assign({ engineNote: ({ event }) => event.note }) },
        CONVERT_DONE: {
          target: "done",
          actions: assign({
            result: ({ event }) => event.result,
            progress: 1,
            engineNote: "",
            handle: null,
          }),
        },
        CONVERT_ERROR: {
          target: "ready",
          actions: assign({
            error: ({ event }) => {
              const e = event.error;
              if (e instanceof Error && e.name === "ConversionCanceledError") {
                return "Conversion canceled.";
              }
              return e instanceof Error ? e.message : "Conversion failed.";
            },
            engineNote: "",
            handle: null,
            progress: 0,
          }),
        },
        CANCEL: {
          target: "ready",
          actions: [
            ({ context }) => {
              void context.handle?.cancel();
            },
            assign({ error: "Conversion canceled.", engineNote: "", handle: null, progress: 0 }),
          ],
        },
      },
    },

    done: {
      tags: "done",
      on: {
        AGAIN: {
          target: "ready",
          actions: ["revokeResult", assign({ result: null, progress: 0, error: "" })],
        },
        SET_FORMAT: {
          target: "ready",
          actions: [
            "revokeResult",
            assign({ formatId: ({ event }) => event.id, result: null, progress: 0 }),
          ],
        },
        SET_RES: {
          target: "ready",
          actions: [
            "revokeResult",
            assign({ resId: ({ event }) => event.id, result: null, progress: 0 }),
          ],
        },
        SET_QUALITY: {
          target: "ready",
          actions: [
            "revokeResult",
            assign({ qualityId: ({ event }) => event.id, result: null, progress: 0 }),
          ],
        },
        SET_TRIM: {
          target: "ready",
          actions: [
            "revokeResult",
            assign({ trim: ({ event }) => event.trim, result: null, progress: 0 }),
          ],
        },
        SET_IN_POINT: {
          target: "ready",
          actions: [
            "revokeResult",
            assign(({ context }) => {
              const src = compToSource(context.timeline, context.time);
              if (src == null) return {};
              return {
                trim: {
                  start: Math.min(src, context.trim.end - MIN_CLIP_SEC),
                  end: context.trim.end,
                },
                result: null,
                progress: 0,
              };
            }),
          ],
        },
        SET_OUT_POINT: {
          target: "ready",
          actions: [
            "revokeResult",
            assign(({ context }) => {
              const src = compToSource(context.timeline, context.time);
              if (src == null) return {};
              return {
                trim: {
                  start: context.trim.start,
                  end: Math.max(src, context.trim.start + MIN_CLIP_SEC),
                },
                result: null,
                progress: 0,
              };
            }),
          ],
        },
        ADD_MEDIA_CLIP: {
          target: "#fluxcut.addingClip",
          guard: ({ context }) => context.pickTarget != null,
        },
        LOAD_FILE: {
          target: "loading",
          actions: [
            "revokeFileUrl",
            "revokeResult",
            "stopClock",
            assign({
              file: ({ event }) => event.file,
              error: "",
              time: 0,
              playing: false,
              timeline: EMPTY_TIMELINE,
              selectedClipId: null,
              drag: null,
            }),
          ],
        },
        LOAD_URL: {
          target: "downloading",
          actions: [
            "revokeFileUrl",
            "revokeResult",
            assign({ pendingUrl: ({ event }) => event.url, error: "", progress: 0 }),
          ],
        },
        CLEAR: {
          target: "empty",
          actions: ["revokeFileUrl", "revokeResult", "resetFile", "stopClock"],
        },
      },
    },

    // Transient: probing one track-media file before placing its clip
    addingClip: {
      tags: "addingClip",
      invoke: {
        src: "probeMedia",
        input: ({ context, event }) => {
          const add = event as Extract<FluxcutEvent, { type: "ADD_MEDIA_CLIP" }>;
          return { file: add.file, trackId: context.pickTarget! };
        },
        onDone: {
          target: "#fluxcut.ready",
          actions: assign(({ context, event }) => {
            const next = addMediaClip(
              context.timeline,
              event.output.trackId,
              event.output.asset,
              context.time
            );
            if (!next) return { error: "That file doesn't fit this track." };
            return {
              ...resolveTimeline(context, next.timeline),
              selectedClipId: next.clipId,
            };
          }),
        },
        onError: {
          target: "#fluxcut.ready",
          actions: assign({
            error: ({ event }) =>
              event.error instanceof Error
                ? event.error.message
                : "Couldn't read that media file.",
          }),
        },
      },
    },
  },
});

/* ---------- helpers ---------- */

export type FluxcutStatus = "idle" | "downloading" | "loading" | "converting" | "done";

/**
 * Derive the user-facing workflow status from state tags — the machine's
 * topology is the single source of truth; nothing is copied into context.
 */
export function statusOf(snapshot: { hasTag(tag: string): boolean }): FluxcutStatus {
  if (snapshot.hasTag("converting")) return "converting";
  if (snapshot.hasTag("downloading")) return "downloading";
  if (snapshot.hasTag("loading")) return "loading";
  if (snapshot.hasTag("done")) return "done";
  return "idle";
}
