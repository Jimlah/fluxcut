// Fluxcut conversion engine — powered by mediabunny (WebCodecs, fully in-browser)
// https://mediabunny.dev
//
// mediabunny is lazy-loaded: its ~600 kB engine chunk downloads on first
// conversion instead of blocking first paint.
import type { Conversion, Output } from "mediabunny";
import type { TrimRange } from "./types";

type MB = typeof import("mediabunny");
let mbPromise: Promise<MB> | null = null;
function mb(): Promise<MB> {
  mbPromise ??= import("mediabunny");
  return mbPromise;
}

export interface ConversionResult {
  blob: Blob;
  size: number;
  name: string;
  codec: string;
  dims: { width: number; height: number };
}

export interface FormatDef {
  id: string;
  label: string;
  ext: string;
  mime: string;
  codec: string;
  fallback: string | null;
  make: (mb: MB) => Output["format"];
}

export const FORMATS: FormatDef[] = [
  { id: "mp4", label: "MP4", ext: ".mp4", mime: "video/mp4", codec: "avc", fallback: null, make: (m) => new m.Mp4OutputFormat() },
  { id: "webm", label: "WebM", ext: ".webm", mime: "video/webm", codec: "vp9", fallback: "vp8", make: (m) => new m.WebMOutputFormat() },
  { id: "mov", label: "MOV", ext: ".mov", mime: "video/quicktime", codec: "avc", fallback: null, make: (m) => new m.MovOutputFormat() },
  { id: "mkv", label: "MKV", ext: ".mkv", mime: "video/x-matroska", codec: "vp9", fallback: "vp8", make: (m) => new m.MkvOutputFormat() },
];

export interface ResDef {
  id: string;
  label: string;
  side: number;
}

export const RESOLUTIONS: ResDef[] = [
  { id: "source", label: "Source", side: 0 },
  { id: "1080", label: "1080p", side: 1080 },
  { id: "720", label: "720p", side: 720 },
  { id: "480", label: "480p", side: 480 },
  { id: "360", label: "360p", side: 360 },
];

export interface QualityDef {
  id: string;
  label: string;
  mult: number;
}

export const QUALITIES: QualityDef[] = [
  { id: "high", label: "High", mult: 1 },
  { id: "medium", label: "Medium", mult: 0.6 },
  { id: "low", label: "Low", mult: 0.35 },
];

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

export function targetDims(srcW: number, srcH: number, resId: string): { width: number; height: number } | null {
  const res = RESOLUTIONS.find((r) => r.id === resId);
  if (!res || !res.side || !srcW || !srcH) return null;
  const S = res.side;
  // Scale so the SHORT side matches the target ("720p" works for portrait too)
  return srcH > srcW
    ? { width: even(S), height: even(Math.round((srcH * S) / srcW)) }
    : { width: even(Math.round((srcW * S) / srcH)), height: even(S) };
}

function bitrateFor(shortSide: number, qualityId: string): number {
  const baseMbps = shortSide <= 480 ? 2.5 : shortSide <= 720 ? 5 : 8;
  const mult = QUALITIES.find((q) => q.id === qualityId)?.mult ?? 0.6;
  return Math.round(baseMbps * mult * 1_000_000);
}

// Probe which output formats this browser can actually encode.
// Returns format ids (mp4/webm/mov/mkv) whose codec — including the vp9->vp8
// fallback chain — is supported by WebCodecs VideoEncoder.
export async function probeSupportedFormats(): Promise<string[]> {
  const out: string[] = [];
  for (const f of FORMATS) {
    const codecs = [f.codec, f.fallback].filter(Boolean) as string[];
    for (const codec of codecs) {
      try {
        const support = await VideoEncoder.isConfigSupported({
          codec,
          width: 1280,
          height: 720,
          bitrate: 5_000_000,
          framerate: 30,
        });
        if (support.supported) {
          out.push(f.id);
          break;
        }
      } catch {
        /* codec unrecognized — keep probing */
      }
    }
  }
  return out;
}

// Pick a codec the browser can actually encode (graceful vp9 -> vp8 fallback)
async function pickCodec(
  preferred: string,
  fallback: string | null,
  dims: { width: number; height: number },
  bitrate: number
): Promise<string> {
  const candidates = fallback ? [preferred, fallback] : [preferred];
  for (const codec of candidates) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width: dims.width,
        height: dims.height,
        bitrate,
        framerate: 30,
      });
      if (support.supported) return codec;
    } catch {
      /* keep trying */
    }
  }
  throw new Error(
    "Your browser can't encode this format. Try Chrome/Edge, or pick MP4 (H.264)."
  );
}

export interface ConvertParams {
  file: File;
  srcW: number;
  srcH: number;
  formatId: string;
  resId: string;
  qualityId: string;
  trim: TrimRange | null;
  duration: number;
  onProgress?: (p: number) => void;
  onCodec?: (codec: string) => void;
  /** Receives the live Conversion instance right after init — keep a handle to call .cancel() */
  onConversion?: (conversion: Conversion) => void;
}

export async function runConversion(params: ConvertParams): Promise<ConversionResult> {
  const {
    file,
    srcW,
    srcH,
    formatId,
    resId,
    qualityId,
    trim,
    duration,
    onProgress,
    onCodec,
    onConversion,
  } = params;

  const m = await mb();
  const { Input, Output, BlobSource, BufferTarget, ALL_FORMATS, Conversion } = m;

  const format = FORMATS.find((f) => f.id === formatId) ?? FORMATS[0];
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });

  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error("This file has no video track — nothing to convert.");

  const trackW = videoTrack.codedWidth ?? srcW;
  const trackH = videoTrack.codedHeight ?? srcH;
  if (!trackW || !trackH) throw new Error("Couldn't read the video dimensions of this file.");

  const dims = targetDims(trackW, trackH, resId) ?? { width: even(trackW), height: even(trackH) };
  const shortSide = Math.min(dims.width, dims.height);
  const bitrate = bitrateFor(shortSide, qualityId);
  const codec = await pickCodec(format.codec, format.fallback, dims, bitrate);
  onCodec?.(codec);

  const output = new Output({ format: format.make(m), target: new BufferTarget() });

  const options: Parameters<typeof Conversion.init>[0] = {
    input,
    output,
    video: {
      codec: codec as "avc" | "vp9" | "vp8",
      bitrate,
      width: dims.width,
      height: dims.height,
      fit: "contain",
    },
  };

  const useTrim =
    !!trim &&
    trim.end - trim.start > 0.05 &&
    (trim.start > 0.05 || (duration > 0 && trim.end < duration - 0.05));
  if (useTrim && trim) options.trim = { start: trim.start, end: trim.end };

  const conversion = await Conversion.init(options);
  onConversion?.(conversion);

  if (!conversion.isValid) {
    const dropped = conversion.discardedTracks.map((t) => t.track.type).join(", ");
    throw new Error(
      dropped
        ? `Can't convert to ${format.label}: the ${dropped} track can't be carried over.`
        : `Can't convert this file to ${format.label}.`
    );
  }

  conversion.onProgress = (p) => onProgress?.(Math.min(1, Math.max(0, p)));
  await conversion.execute();

  const buffer = output.target.buffer;
  if (!buffer) throw new Error("Conversion produced no output.");
  const blob = new Blob([buffer], { type: format.mime });
  const baseName = (file.name || "video").replace(/\.[^./]+$/, "") || "video";
  return {
    blob,
    size: blob.size,
    name: `${baseName} ${format.label.toLowerCase()}${format.ext}`,
    codec,
    dims,
  };
}

