# Audio mixing and cleanup — design (v1 contract)

Feature. "Volume keyframing, audio ducking (music lowers when someone speaks), EQ, compression, and background noise removal."
Owner thread: figure-it-out run 2026-11-12. No arena panel ran; the shape follows the same invariants as the two prior design docs and the standing AGENTS.md rule. A fresh review agent reads the landed diff before the final reply.

> Standing rule: every user intent is one machine event; components hold no
> domain state (refs and view-model subscriptions only). See AGENTS.md.

## Boundary

The mixer shapes preview playback only. The convert pipeline re-encodes the single
original file (trim, resolution, quality) and never renders the timeline, so mixer
settings do not reach the exported file. That gap predates this feature; rendering a
composition timeline into the export is accepted out-of-scope work, listed below.

## Data shape (the organizing structure)

```ts
// src/lib/timeline.ts grows three pieces:

export type MixParams = {
  gain: number;                 // linear multiplier, clamped [0, 2], default 1
  keyframes: VolumeKeyframe[];  // sorted by t, unique t, t in [0, duration]; MAX 64
  // EQ: three BiquadFilter bands, dB each in clamped [-24, 24], default 0
  eqOn: boolean;
  eqLowDb: number; eqMidDb: number; eqHighDb: number;
  // Compression: one amount knob, [0, 1], default 0.5 when on
  compressOn: boolean; compressAmount: number;
  // Noise cleanup: high-pass at 90 Hz + downward expander acting as a gate
  cleanOn: boolean;
};
export type VolumeKeyframe = { t: Sec; g: number }; // g CLAMPED [0, 2]

// AudioClip and VideoClip both grow: mix: MixParams (never optional invariants below).

// Sound-carrying track variants (audio AND video) grow one field:
| { id: TrackId; kind: "audio"; name: string; clips: AudioClip[]; duck: boolean }
| { id: TrackId; kind: "video"; name: string; clips: VideoClip[]; duck: boolean }
// duck = "this track lowers itself under non-ducking tracks" (a ducker).
// Defaults: audio tracks duck === true, video tracks duck === false (the main video
// carries the dialogue). The mixer panel toggles it; no auto speech detection exists.
```

Defaults ship as one constructor `defaultMix()`; `addTrack`, `bootstrapMainVideo`
and `addMediaClip` fill the new fields, so no clip in a valid timeline can lack `mix`
or a sound-carrying track lack `duck`.

Invariants (pure helpers in `src/lib/timeline.ts`, UI never writes fields directly):
- Keyframes stay sorted by strictly increasing `t`, `0 <= t <= duration`, `g` in [0, 2], at most 64.
- Splitting redistributes: the left piece keeps `t < leftDur`, the right piece shifts by `-leftDur`; keyframes beyond the new span drop.
- Trim/resize/speed/move/slip never mutate keyframes (they are clip-local composition seconds; a fade survives a left trim attached to the clip's start). An out-of-span keyframe is simply never evaluated.
- Ducking is per track. Nothing per-clip duplicates it.
- History equivalence (`timelinesEquivalent`) compares mix fields and duck flags, so a mixer burst that started and ended at the same values still records nothing.

## Mix math (pure, in `src/lib/audio.ts`, no DOM)

Constants: `DUCK_AMOUNT = 0.25` (ducked to -12 dB), `DUCK_ATTACK = 0.04` s,
``DUCK_RELEASE = 0.5` s.

```ts
envelope(mix: MixParams, t: Sec): number
// linear interpolation between neighboring keyframes; constant outside the span
// (first value before the first point, last after it). No keyframes -> 1.

duckFactor(tracks: Track[], t: Sec): number
// 1 unless a dialogue source is live: collect every clip on a duck === false
// sound-carrying track; per boundary take
//   interval [S, E): DUCK_AMOUNT inside; 1 -> DUCK_AMOUNT linear over ATTACK
//   approaching S;  DUCK_AMOUNT -> 1 linear over RELEASE after E.
// The final factor is the min over every boundary term, clamped to [DUCK_AMOUNT, 1].

mixGain(tl: Timeline, t: Sec): Map<ClipId, number>
// for every clip on a sound-carrying track: envelope x (track.duck ? duckFactor : 1).
```

The engine consumes `mixGain` per clock tick. Test at fixed times: inside, before and
after the ramp windows, and two overlapping dialogue intervals (the min rule).

## Statechart integration

Standing instruction from the operator: every action and detail goes through the
statechart. The engine holds no state the machine did not project into it — the
Compositor effect reads `PreviewMedia.mix` / `mixGain` each tick and stamps the
nodes; the dev hook only reports what the engine holds. No UI control writes a
mix field directly.

New events (`FluxcutEvent`, each one machine event per intent):
- `SET_CLIP_MIX { clipId, control: string, patch: SettableMix }` where
  `SettableMix = { gain?, eqOn?, eqLowDb?, eqMidDb?, eqHighDb?, compressOn?,
  compressAmount?, cleanOn? }`. `control` names the UI control (slider) so the edit
  coalesces: `applyTimelineEdit` gains an `opts.coalesceKind` and opens transactions of
  new kind "mix" with key `"mix:" + clipId + ":" + control`.
- `UPSERT_CLIP_KEYFRAME { clipId, t, g }` — helper validates t in span and g in range; coalesces per control too (the gain slider of one keyframe row).
- `REMOVE_CLIP_KEYFRAME { clipId, t }` — matches the nearest keyframe within 0.01 s, else keeps state.
- `RESET_CLIP_MIX { clipId }` — back to defaults.
- `SET_TRACK_DUCK { trackId, duck }` — one-shot edit, plain register.

``history.ts`: `OpenTransaction` gains kind "mix"; `canUndo`/`canRedo` allow undo to
settle a mix burst the same way they settle a text burst. `clipsEquivalent` and
`timelinesEquivalent` compare mix + duck.

## Engine (`src/lib/audioEngine.ts`, imperative, thin; imported only by the Compositor)

One shared `AudioContext`. Per sound-carrying clip element a graph, keyed by ClipId:

```
MediaElementAudioSourceNode
  -> BiquadFilterNode high-pass 90 Hz        (cleanOn)
  -> BiquadFilterNode lowshelf 120 Hz        (eqLowDb, eqOn)
  -> BiquadFilterNode peaking 1.5 kHz Q 0.8  (eqMidDb, eqOn)
  -> BiquadFilterNode highshelf 4.5 kHz      (eqHighDb, eqOn)
  -> DynamicsCompressorNode                  (compressOn; threshold and ratio derive from amount)
  -> DynamicsCompressorNode ratio 20, threshold -45 dB, act as expander/gate (cleanOn)
  -> GainNode                                (envelope x baseline x duck factor)
  -> AudioContext.destination
```

Biquads and compressor params update only when their value changes (the node holds the
last applied MixParams identity). Gain follows the machine clock: the Compositor effect
reads `PreviewMedia.mixGain` (computed in `selectPreview` via `mixGain(tl, time)`) and
applies `setTargetAtTime(target, ctx.currentTime, 0.03)`. Element volume stays 1 — the
graph owns loudness entirely. The context resumes on every tick while suspended (the
autoplay policy needs the user gesture, which play already IS). Elements keep the
existing pause/seek behavior; paused elements pass silence through the graph.

Cleanup path removes a clip id's graph when its element unmounts (the Compositor ref
callback already deletes from the element map; it unregisters from the engine too).
`LOAD_FILE`/`CLEAR` reset: the Compositor unmounts, taking every graph with it.

A dev-only snapshot lands on `window.__FLUXCUT_MIX__` for the browser lever
(`import.meta.env.DEV` gate; reports per-clip graph ids, node kinds, param values, gain).

Noise cleanup honesty: high-pass plus a fixed-threshold expander reduces steady hum and
hiss; it is not spectral voice isolation. The panel labels it "Clean (hiss, hum)".

## UI

- A `MixerPanel` mounts in the right dock behind the existing rail tool "mix" (the
  Music2 tool becomes the mixer): sliders for volume, EQ bands, compressor amount, a keyframe list with add-at-playhead and remove, on/off toggles. It edits the selected sound-carrying clip. No selected sound clip -> a one-line hint, not a dead panel.
- The duck toggle lives in the mixer panel (bound to the selected clip's track).
  A lane-header button was tried and cut: at narrow widths the rail overlay sits
  over the first lane-head button, so the control was unreachable on screen.
- Volume keyframes render in the mixer panel; no waveform or curve drawing in v1.

## Out of scope (accepted tradeoffs — do not add here)

Timeline rendering into the exported file (mixer stays preview-only), speech detection
(ducking follows the duck toggle, not heard speech), spectral noise suppression, keyframe
dragging on a curve, per-track EQ/compression, duck amount sliders (constants hold), mixer
persistence (none of the timeline persists today).

## Success criteria

1. `npm run build` (tsc + vite) and `npm run lint` pass.
2. `node scripts/check-timeline.mjs` extended green: mix invariants, split redistribution, duck defaults, history equivalence.
3. New `node scripts/check-audio-mix.mjs` green: envelope interpolation, duck factor ramps and the min rule, mixGain mapping.
4. New `scripts/browser-smoke.mjs` (headless Chrome over CDP) green: the app boots into the populated timeline from the vendored sample.
5. Strict browser audio suite green on the real app: main video clip carries a graph whose gain follows a keyframe edit, duck toggling changes the audio-clip gain during dialogue-overlap and recovers after release.
