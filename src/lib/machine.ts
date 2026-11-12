// Fluxcut statechart — modeled with XState v5 (Stately)
// https://stately.ai/docs
//
// empty ──LOAD_FILE──▶ loading ──done──▶ ready ──CONVERT──▶ converting ──▶ done
//   ▲                    │               ▲   ▲                │          │
//   └──────CLEAR─────────┘               │   └──CANCEL───────┘          │
//                                       └─────AGAIN / settings─────────┘
//
// Global actors (invoked at machine root, alive for the machine's lifetime):
//   - dragDropActor  : window drag & drop → DRAG_OVER / DROP_FILE
//   - videoSyncActor : the stage <video> element → SET_TIME / SET_PLAYING / SET_DURATION
// React hands DOM elements over via ATTACH_VIDEO / ATTACH_INPUT; playback
// commands (PLAY / PAUSE / TOGGLE_PLAY / SEEK / SEEK_BY) act on context.videoEl.
import { setup, assign, fromPromise, fromCallback, raise, sendTo } from "xstate";
import type { Conversion } from "mediabunny";
import { runConversion, probeSupportedFormats } from "./convert";
import { captureFilmstrip } from "./video";
import type { FileMeta, ResultInfo, TrimRange } from "./types";

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
  | { type: "SET_TIME"; time: number }
  | { type: "SET_PLAYING"; playing: boolean }
  | { type: "TOGGLE_GRID" }
  | { type: "DRAG_OVER"; over: boolean }
  | { type: "DROP_FILE"; file: File }
  | { type: "ATTACH_VIDEO"; element: HTMLVideoElement }
  | { type: "DETACH_VIDEO" }
  | { type: "ATTACH_INPUT"; element: HTMLInputElement }
  | { type: "PLAY" }
  | { type: "PAUSE" }
  | { type: "TOGGLE_PLAY" }
  | { type: "SEEK"; time: number }
  | { type: "SEEK_BY"; delta: number }
  | { type: "ATTACH_STRIP"; element: HTMLDivElement }
  | { type: "DETACH_STRIP" }
  | { type: "DRAG_STRIP"; clientX: number }
  | { type: "STRIP_SEEK"; pct: number }
  | { type: "SET_DURATION"; duration: number }
  | { type: "SET_PROJECT_NAME"; name: string }
  | { type: "SET_PANEL_OPEN"; open: boolean }
  | { type: "TOGGLE_PANEL" }
  | { type: "SET_TOOL"; tool: string }
  | { type: "REQUEST_PICK_FILE" }
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
  time: number;
  playing: boolean;
  gridOn: boolean;
  dragOver: boolean;
  /** Live reference to the stage video element — attached from React */
  videoEl: HTMLVideoElement | null;
  /** Hidden file input element — attached from the FilePicker component */
  fileInput: HTMLInputElement | null;
  /** Timeline strip element — attached from the Timeline component */
  stripEl: HTMLDivElement | null;
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
  videoEl: null,
  fileInput: null,
  stripEl: null,
  pendingUrl: null,
  projectName: "Untitled conversion",
  panelOpen: true,
  activeTool: "clip",
  supportedFormats: [],
  capsProbed: false,
};

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

// Owns the media-element wiring: React hands the stage <video> over via
// ATTACH/DETACH (relayed by the machine with sendTo), and this actor streams
// time, playing state and duration back as events.
type VideoSyncEvent =
  | { type: "ATTACH"; element: HTMLVideoElement }
  | { type: "DETACH" }
  | { type: "SET_TIME"; time: number }
  | { type: "SET_PLAYING"; playing: boolean }
  | { type: "SET_DURATION"; duration: number };

const videoSyncActor = fromCallback<VideoSyncEvent, undefined>(({ sendBack, receive }) => {
  let el: HTMLVideoElement | null = null;

  const onTime = () => {
    // Skip timeupdate noise while the user is dragging the playhead
    if (el && !el.seeking) sendBack({ type: "SET_TIME", time: el.currentTime });
  };
  const onSeeked = () => {
    if (el) sendBack({ type: "SET_TIME", time: el.currentTime });
  };
  const onPlay = () => sendBack({ type: "SET_PLAYING", playing: true });
  const onPause = () => sendBack({ type: "SET_PLAYING", playing: false });
  const onDuration = () => {
    if (el && isFinite(el.duration)) sendBack({ type: "SET_DURATION", duration: el.duration });
  };

  const detach = () => {
    if (!el) return;
    el.removeEventListener("timeupdate", onTime);
    el.removeEventListener("seeked", onSeeked);
    el.removeEventListener("play", onPlay);
    el.removeEventListener("pause", onPause);
    el.removeEventListener("durationchange", onDuration);
    el = null;
  };
  const attach = (element: HTMLVideoElement) => {
    detach();
    el = element;
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("seeked", onSeeked);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("durationchange", onDuration);
    // Initial sync so the machine knows the element state right away
    if (isFinite(el.duration) && el.duration > 0) {
      sendBack({ type: "SET_DURATION", duration: el.duration });
    }
    sendBack({ type: "SET_TIME", time: el.currentTime });
    sendBack({ type: "SET_PLAYING", playing: !el.paused });
  };

  receive((event) => {
    if (event.type === "ATTACH") attach(event.element);
    if (event.type === "DETACH") detach();
  });
  return () => detach();
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

// Timeline strip playhead dragging. React only reports the pointer-down X;
// this actor owns the capture, computes the percentage from the strip rect,
// and streams STRIP_SEEK back on every move. Cleaned up on pointerup.
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
  actors: { loadVideoMeta, convertActor, dragDropActor, videoSyncActor, keyboardActor, capsActor, stripDragActor, fetchVideo },
  actions: {
    revokeResult: ({ context }) => {
      if (context.result) URL.revokeObjectURL(context.result.url);
    },
    revokeFileUrl: ({ context }) => {
      if (context.fileUrl) URL.revokeObjectURL(context.fileUrl);
    },
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
    }),
  },
}).createMachine({
  id: "fluxcut",
  initial: "empty",
  context: defaultContext,
  // Global actors — alive for the machine's entire lifetime
  invoke: [
    { src: "dragDropActor" },
    { src: "videoSyncActor", id: "videoSync" },
    { src: "keyboardActor" },
    { src: "capsActor" },
    { src: "stripDragActor", id: "stripDrag" },
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
    SET_TIME: {
      actions: assign({ time: ({ event }) => event.time }),
    },
    SET_PLAYING: {
      actions: assign({ playing: ({ event }) => event.playing }),
    },
    TOGGLE_GRID: {
      actions: assign({ gridOn: ({ context }) => !context.gridOn }),
    },
    // Guarded so a flood of dragover events doesn't spam re-renders
    DRAG_OVER: {
      guard: ({ context, event }) => context.dragOver !== event.over,
      actions: assign({ dragOver: ({ event }) => event.over }),
    },
    // ---- video element lifecycle ----
    ATTACH_VIDEO: {
      actions: [
        assign({ videoEl: ({ event }) => event.element }),
        sendTo("videoSync", ({ event }) => {
          const attach = event as Extract<FluxcutEvent, { type: "ATTACH_VIDEO" }>;
          return { type: "ATTACH", element: attach.element };
        }),
      ],
    },
    DETACH_VIDEO: {
      actions: [sendTo("videoSync", { type: "DETACH" }), assign({ videoEl: null })],
    },
    // ---- timeline strip lifecycle + dragging ----
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
    STRIP_SEEK: {
      actions: ({ context, event }) => {
        const v = context.videoEl;
        const d = v && isFinite(v.duration) ? v.duration : 0;
        if (!v || !d) return;
        v.currentTime = Math.max(0, Math.min(event.pct * d, d - 0.05));
      },
    },
    ATTACH_INPUT: {
      actions: assign({ fileInput: ({ event }) => event.element }),
    },
    // ---- playback control: the machine drives the element ----
    PLAY: {
      actions: ({ context }) => {
        void context.videoEl?.play().catch(() => {});
      },
    },
    PAUSE: {
      actions: ({ context }) => {
        context.videoEl?.pause();
      },
    },
    TOGGLE_PLAY: {
      actions: ({ context }) => {
        const v = context.videoEl;
        if (!v) return;
        if (v.paused) void v.play().catch(() => {});
        else v.pause();
      },
    },
    SEEK: {
      actions: ({ context, event }) => {
        const v = context.videoEl;
        if (!v || !isFinite(v.duration) || !v.duration) return;
        v.currentTime = Math.max(0, Math.min(event.time, v.duration - 0.05));
      },
    },
    SEEK_BY: {
      actions: ({ context, event }) => {
        const v = context.videoEl;
        if (!v || !isFinite(v.duration) || !v.duration) return;
        v.currentTime = Math.max(
          0,
          Math.min(v.currentTime + event.delta, v.duration - 0.05)
        );
      },
    },
    SET_DURATION: {
      actions: assign({
        meta: ({ context, event }) => ({ ...context.meta, duration: event.duration }),
      }),
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
        assign({ panelOpen: true }),
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
                event.error instanceof Error
                  ? event.error.message
                  : "Couldn't download that URL.",
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
        SET_IN_POINT: {
          actions: assign({
            trim: ({ context }) => ({
              start: Math.min(context.time, context.trim.end - 0.2),
              end: context.trim.end,
            }),
          }),
        },
        SET_OUT_POINT: {
          actions: assign({
            trim: ({ context }) => ({
              start: context.trim.start,
              end: Math.max(context.time, context.trim.start + 0.2),
            }),
          }),
        },
        CONVERT: {
          target: "converting",
          actions: assign({ panelOpen: true }),
        },
        LOAD_FILE: {
          target: "loading",
          actions: [
            "revokeFileUrl",
            assign({
              file: ({ event }) => event.file,
              error: "",
              result: null,
              progress: 0,
              time: 0,
              playing: false,
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
        CLEAR: { target: "empty", actions: ["revokeFileUrl", "resetFile"] },
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
        RESET_TRIM: {
          target: "ready",
          actions: [
            "revokeResult",
            assign({
              trim: ({ context }) => ({ start: 0, end: context.meta.duration || 0 }),
              result: null,
              progress: 0,
            }),
          ],
        },
        SET_IN_POINT: {
          target: "ready",
          actions: [
            "revokeResult",
            assign({
              trim: ({ context }) => ({
                start: Math.min(context.time, context.trim.end - 0.2),
                end: context.trim.end,
              }),
              result: null,
              progress: 0,
            }),
          ],
        },
        SET_OUT_POINT: {
          target: "ready",
          actions: [
            "revokeResult",
            assign({
              trim: ({ context }) => ({
                start: context.trim.start,
                end: Math.max(context.time, context.trim.start + 0.2),
              }),
              result: null,
              progress: 0,
            }),
          ],
        },
        LOAD_FILE: {
          target: "loading",
          actions: [
            "revokeFileUrl",
            "revokeResult",
            assign({
              file: ({ event }) => event.file,
              error: "",
              time: 0,
              playing: false,
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
          actions: ["revokeFileUrl", "revokeResult", "resetFile"],
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
