# Multi-Track Timeline — synthesized design (v1 contract)

Feature. "Stack and arrange multiple layers of video, audio, images, and text independently."
Base: arena candidate A (deepseek-v4.1-flash). Cross-judge: mistral-large-4, ranked it #1 on every rubric axis; the second seat (minimax-m3) is a noted dropout (empty body twice through the panel). Grafts below close the judge's gap list.

> Standing rule: every user intent is one machine event; components hold no
> domain state (refs and view-model subscriptions only). See AGENTS.md.

## Data shape (the organizing structure)

Two planes: an asset registry + an ordered track list with kind-typed clip lists.

```ts
type Sec = number;
type AssetId = string; type TrackId = string; type ClipId = string;

type Asset =
  | { id: AssetId; kind: "video"; url: string; duration: Sec; w: number; h: number; poster: string; frames?: string[] }
  | { id: AssetId; kind: "audio"; url: string; duration: Sec }
  | { id: AssetId; kind: "image"; url: string; w: number; h: number };

type VisualClipKind = "video" | "image" | "text";
type TrackKind = VisualClipKind | "audio";

// start/duration are COMPOSITION seconds; sourceStart is SOURCE seconds (clip's in-point).
export type Track =
  | { id: TrackId; kind: "video"; name: string; clips: Extract<Clip, { kind: "video" }>[] }
  | { id: TrackId; kind: "image"; name: string; clips: Extract<Clip, { kind: "image" }>[] }
  | { id: TrackId; kind: "text";  name: string; clips: Extract<Clip, { kind: "text"  }>[] }
  | { id: TrackId; kind: "audio"; name: string; clips: Extract<Clip, { kind: "audio" }>[] };

type Clip =
  | { id: ClipId; kind: "video"; start: Sec; duration: Sec; assetId: AssetId; sourceStart: Sec }
  | { id: ClipId; kind: "audio"; start: Sec; duration: Sec; assetId: AssetId; sourceStart: Sec }
  | { id: ClipId; kind: "image"; start: Sec; duration: Sec; assetId: AssetId }
  | { id: ClipId; kind: "text";  start: Sec; duration: Sec; text: string };

type Timeline = {
  tracks: Track[];      // INV: index 0..v-1 visual lanes displayed top->bottom; visual section is a prefix, audio section follows.
  assets: Record<AssetId, Asset>;   // INV: every clip.assetId resolves; asset.kind === clip.kind.
  primaryVideoClipId: ClipId | null; // INV: names a live VideoClip or null (main source clip).
};
```

Invariants (enforced by pure helpers in `src/lib/timeline.ts`, never by UI):
- z-order is derivable from track position. Never stored per clip or per track.
- Same-track clips never overlap. Helpers return `null` on an illegal placement; the caller keeps the previous state.
- `sourceStart` only exists on file-backed media with a duration (video/audio); resize clamps `sourceStart + duration <= asset.duration`.
- Speed: media clips carry `speed` in composition-seconds-per-source-second (0.25 to 8, default 1), so `sourceLen = duration * speed` and the source bound reads `sourceStart + duration * speed <= asset.duration`.
- Min clip duration 0.2s everywhere.
- Composition end: `compositionEnd(tl) = max(clip.start + clip.duration)`, floor 0.

## Machine integration (owner of all domain state)

Context additions: `timeline: Timeline`, `selectedClipId: ClipId | null`,
`drag: { clipId: ClipId; mode: "move" | "left" | "right"; anchorTime: Sec } | null`.

Events: ADD_TRACK, REMOVE_TRACK, MOVE_TRACK {trackId, dir: -1|1} (within its section),
ADD_TEXT_CLIP, SET_CLIP_TEXT, SELECT_CLIP, CLIP_DELETE,
ADD_MEDIA_CLIP {trackId, file} (enters a transient `addingClip` state invoking `probeMedia`; the placed clip becomes selected for immediate feedback),
CLIP_DRAG_START {clipId, mode, time}, CLIP_DRAG_MOVE {time}, CLIP_DRAG_END (mode gains "slip" and "slide"),
CUT_CLIP {clipId, time} (razor split; the right piece is selected), CLIP_DELETE_RIPPLE {clipId} (delete + close the gap), SET_CLIP_SPEED {clipId, speed},
SEEK/PLAY/PAUSE/TOGGLE_PLAY (repurposed to the composition clock — same names, new semantics),
TIMELINE_TICK {dt} (internal), SET_IN_POINT/SET_OUT_POINT (comp->source projection).

Composition clock: new `src/lib/clock.ts` rAF actor (`fromCallback`), receives
CLOCK_START/CLOCK_STOP, emits TIMELINE_TICK(dt). Machine handler: while playing,
`time = (time + dt) % compositionEnd` (loop to 0; auto-stop when timeline has no clips).
Machine-owned `time`. NO element ever reports time back — the SET_TIME path dies with videoSyncActor.

videoSyncActor, ATTACH_VIDEO/DETACH_VIDEO, videoEl: DELETE after migrating every caller
(migrate-callers-then-delete). App's stage single <video> is replaced by Compositor (except the idle hero state).

Bootstrap: loadVideoMeta onDone registers the video asset and calls
`bootstrapMainVideo(timeline, asset, duration)` -> one "Video 1" track, clip {start: 0, sourceStart: 0}, primaryVideoClipId, trim {0, duration}, time 0. LOAD_FILE keeps its name (no rename churn).

Trim mapping: `compToSource(tl, compTime)` projects through primaryVideoClipId; SET_IN/OUT use it when it returns a number, otherwise keep the previous trim (In/Out buttons disabled with a hint while the playhead is off the main clip or the primary clip was deleted — conversion itself stays file-based and always available).

Demo/empty state: `tracks.length === 0` -> the existing demo strip; else multi-lane view.

## Preview (Compositor) + element sync

`selectPreview(s): PreviewVM { layers, time, playing, duration, dims }`.
Layer = { clipId, kind, z (visualCount - trackIndex), leftPct, widthPct, media?: {src, sourceTime, active, elKind}, text? }.
dims derive from the primary (or first) video asset w/h; never stored.
Compositor (new component): mounts one element per media clip, keyed by clip id, elements kept in a local ref Map (never context). Effect on every PreviewVM change: active video/audio -> set currentTime when drift > 0.05s or after seek, then play; inactive -> pause. Image/text layers toggle visibility. Text renders as styled overlay; editing uses an input inside the clip (keyboardActor already skips INPUT/TEXTAREA).
All active audio plays unmuted (Premiere parity); overlapping audio is accepted v1 behavior.

## Timeline UI

- Ruler on top: tick labels over compositionEnd; In/Out trim band + playhead line spanning all lanes.
- Lane rows: clip bodies with poster frames (primary video clip tiles context.frames), kind icon + name; drag body to move within its track; drag left/right edges to resize (clamped, overlap-rejected, recomputed from the drag anchor so a rejected candidate never accumulates).
- Lane header: kind icon, name, +/- add (video/image/audio open the media picker filtered to the kind; text + creates a 3s clip at the playhead in edit mode), up/down reorder within section, x remove track (with its clips).
- Ruler scrub reuses the stripDragActor idiom; STRIP_SEEK now maps pct * compositionEnd inside the machine.
- Empty lane click (text/image) -> create placeholder clip at playhead.
- secondsVisible = max(compositionEnd, 10); positions in %; pxPerSec derived in selectTimelineView.

## Media ingest

`probeMedia` actor: File -> Asset (video: captureFilmstrip poster + frames, duration/w/h; audio: duration; image: dimensions via load). FilePicker becomes three-purpose: main video (as today), or a track-kind-filtered picker for ADD_MEDIA_CLIP via REQUEST_PICK_TRACK_MEDIA + pickAccept/pickTarget context fields. No new dependencies; pointer capture everywhere.

## Out of scope for v1 (accepted tradeoffs — do not add)

Zoom/scroll, snapping, clipboard, waveform render, keyframes/effects, opacity/blend,
composition export, persistence, audio mixer/volume, cross-track clip moves, decoder caps
(v1 timelines are small), silent-pausing in hidden tabs (rAF).

## Success criteria

1. `npm run build` (tsc + vite) and `npm run lint` pass.
2. Load main video -> timeline shows Video 1 lane with the clip at 0; stage previews it.
3. Add image/audio/text tracks; add clips to each; drag move + edge resize work; overlap rejected.
4. Reorder and remove tracks; delete clips.
5. Play plays the composition (all layers move together); seek + scrub work; loop at end.
6. Stacked preview respects lane order (upper visual lanes draw on top).
7. In/Out still set converter trim in SOURCE coordinates via the mapping; convert run unaffected.
8. Demo strip still shows when no video is loaded.