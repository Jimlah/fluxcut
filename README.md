# Fluxcut — Video Conversion Studio

A single-page video conversion + editing studio styled after a dark, cinematic
theme (frosted glass, warm gold/red accents, circular tool rail, multi-track
timeline).
All conversion happens **100% in your browser** via
[mediabunny](https://mediabunny.dev) (WebCodecs) — no uploads, no servers.
The app workflow is modeled as a statechart with
[XState v5 / Stately](https://stately.ai/docs) (`src/lib/machine.ts`).

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
```

```bash
npm run build    # typecheck + production build
npm run preview  # serve the production build
```

## What it does

- **Load** a video by drag & drop or the file picker (MP4, WebM, MOV, MKV, …)
- **Multi-track timeline** — stack layers of video, audio, images and text
  independently: add, drag, resize and reorder tracks and clips, with a
  machine-driven composition clock, looped playback and a stacked preview
  (the old filmstrip stays as the first track's face; trim In/Out still drive
  the converter in source coordinates)
- **Convert** to MP4 (H.264), WebM (VP9/VP8), MOV (H.264) or MKV (VP9/VP8),
  with resolution (Source → 360p) and quality presets
- **Trim** with In/Out points (drag the playhead, use the flag buttons or ←/→)
- **Cancel** mid-conversion (the spinning white button)
- Live preview, filmstrip frame capture, progress %, one-click download

The mediabunny engine chunk (~700 kB) is lazy-loaded on first conversion.

## Asset credits (fetched from the internet)

| Asset | Source |
| --- | --- |
| Hero video + default timeline sample — "Golden particles with abstract nebula shapes" (720p stream + 360p copy vendored at `public/samples/`) | [Mixkit](https://mixkit.co/free-stock-video/gold-particles/) |
| Demo filmstrip stills (festival, smoke, glitter, fire…) | [Mixkit](https://mixkit.co) |
| Inter + Space Grotesk typefaces | [Google Fonts](https://fonts.google.com) |
| Icons | [Lucide](https://lucide.dev) (npm: lucide-react) |
| Conversion engine | [mediabunny](https://mediabunny.dev) (npm: mediabunny) |
| State management | [XState v5](https://stately.ai/docs) / [@xstate/react](https://stately.ai/docs/xstate-react) |

Video conversion requires a browser with WebCodecs
(Chrome/Edge recommended; Safari 16.4+ works for MP4/H.264).