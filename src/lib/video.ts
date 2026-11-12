// Video preview helpers: frame capture for the filmstrip + formatting utils

export function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener("seeked", done);
      resolve();
    };
    video.addEventListener("seeked", done);
    video.currentTime = Math.max(0, Math.min(t, (video.duration || 0) - 0.05));
  });
}

// Capture evenly spaced frames as data URLs for the timeline filmstrip
export async function captureFilmstrip(video: HTMLVideoElement, count = 10): Promise<string[]> {
  if (!video.videoWidth || !video.duration) return [];
  const W = 160;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = Math.max(1, Math.round((W * video.videoHeight) / video.videoWidth));
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];
  const frames: string[] = [];
  const d = video.duration;
  try {
    for (let i = 0; i < count; i++) {
      const t = Math.max(0, Math.min(((i + 0.5) / count) * d, d - 0.06));
      await seekTo(video, t);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push(canvas.toDataURL("image/jpeg", 0.62));
    }
  } catch {
    // Cross-origin or decode hiccup — return what we have
  }
  await seekTo(video, 0);
  return frames;
}

export function fmtBytes(bytes?: number): string {
  if (bytes == null) return "";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function fmtTime(s?: number | null): string {
  if (s == null || !isFinite(s)) return "0s";
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

export function aspectLabel(w: number, h: number): string {
  if (!w || !h) return "";
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const d = gcd(w, h);
  const rw = Math.round(w / d);
  const rh = Math.round(h / d);
  if (rw > 40 || rh > 40) {
    // Odd ratio — snap to common ones
    const r = w / h;
    const known: [number, number][] = [
      [16, 9], [9, 16], [4, 3], [3, 4], [1, 1], [21, 9], [3, 2],
    ];
    for (const [a, b] of known) if (Math.abs(r - a / b) < 0.03) return `${a}:${b}`;
    return r > 1 ? `${(w / h).toFixed(1)}:1` : `${(h / w).toFixed(1)}:1`;
  }
  return `${rw}:${rh}`;
}
