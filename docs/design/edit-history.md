# Edit history — synthesized design

Feature. "Add the history feature to allow undo and redo."

Base: arena candidate A (deepseek-v4.1-flash). Cross-judge (mistral-large-4) ranked A 26/30 against candidate B (minimax-m3, 25/30) and recommended A as base. Grafts below fold in three B ideas and close the judge's gap list.

> Standing rule: every user intent is one machine event; domain state lives only in
> FluxcutContext; pure helpers in lib/timeline.ts return null on an illegal change and
> the machine keeps the previous state. See AGENTS.md.

## Problem

A timeline edit is not one shape of change. Track and clip edits fire once per event. A drag streams dozens of accepted projections between pointer down and up. Text edits fire per keystroke while the clip input holds focus. Media placement lands asynchronously after the probe. A naive stack that pushes on every timeline write would record rejected edits, split one drag into dozens of undo steps, and give redo wrong targets. History therefore need explicit transaction boundaries, and it must keep the null-keeps-previous convention untouched.

## Data shape (the organizing structure)

A snapshot journal. Timeline is immutable and assets are shared by reference, so one entry costs one small object, never a copy of media data. Pure module: `src/lib/history.ts`, no XState, no React, no DOM.

```ts
type SnapshotJournal = {
  /** Completed steps, oldest first. Undo pops; capped at 100 entries. */
  past: HistoryEntry[];
  /** Steps undo took away; redo pops. Cleared on any new commit. */
  future: HistoryEntry[];
  /** The one open transaction, exactly one at a time. */
  open:
    | { kind: "drag"; key: string; before: Timeline }
    | { kind: "text"; key: string; before: Timeline }
    | null;
};

type HistoryEntry = { before: Timeline; after: Timeline };
```

The open slot is the transaction boundary. Non-null means a gesture or typing burst is in flight; its `before` holds the timeline captured at the boundary start. The module's functions:

```ts
emptyJournal(): SnapshotJournal;
/** Closed edit: push { before, after }, drop future, evict past beyond 100. */
registerEdit(journal, before: Timeline, after: Timeline): SnapshotJournal;
/** Open a text burst; later keystrokes with the same key leave it alone. */
openTransaction(journal, open): SnapshotJournal;
/** Close the open transaction: drop it when endpoints are equivalent, else push it. */
settleTransaction(journal, current: Timeline): SnapshotJournal;
/** Undo target; null on empty past. Moves top entry to future. */
undoStep(journal): { journal: SnapshotJournal; timeline: Timeline } | null;
/** Redo target; null on empty future. Moves top entry back to past. */
redoStep(journal): { journal: SnapshotJournal; timeline: Timeline } | null;
canUndo(journal): boolean;
canRedo(journal): boolean;
/** Structural equality of tracks and primaryVideoClipId; ends a net-zero gesture. */
timelinesEquivalent(a: Timeline, b: Timeline): boolean;
```

Invariants:
- A rejected edit records nothing. The helper returned null, so the machine never calls registerEdit.
- A no-op edit records nothing. Same-reference results skip registration and keep the future branch.
- One drag gesture is one entry at most, settled at CLIP_DRAG_END; a gesture whose final timeline is equivalent to its baseline records nothing.
- One text burst is one entry at most, settled at the burst boundary; a burst that ends back at its opening value records nothing.
- Redo dies on the next commit. registerEdit clears future.
- Stack cap 100. registerEdit evicts the oldest past entry beyond the cap.

## Machine integration (one commit definition)

`src/lib/history.ts` holds the bookkeeping. `src/lib/machine.ts` adapts it to the statechart through one wrapper, so exactly one place defines what counts as a commit:

```ts
// machine-local. next is a timeline.ts helper result.
// Returns Partial<FluxcutContext>; {} keeps the previous state.
applyTimelineEdit(context, next, opts?: { coalesceKey?: string; select?: ClipId })
```

Wrapper rules, in order:
1. next is null (illegal) or the same object (no-op) -> {} and journal untouched. Rejected edits can never create stale entries because the rule reads the helper result, not the event.
2. An open text burst whose key equals coalesceKey -> project the timeline only. The burst keeps capturing; nothing pushes per keystroke.
3. Otherwise settle any open transaction first, then registerEdit(context.timeline, next) and clear future. Project and, when opts.select is set, select the placed clip.

Event wiring:
- ADD_TRACK, REMOVE_TRACK, MOVE_TRACK, ADD_TEXT_CLIP, CLIP_DELETE, CLIP_DELETE_RIPPLE, CUT_CLIP, SET_CLIP_SPEED call the wrapper. ADD_TEXT_CLIP and the media landing pass opts.select.
- SET_CLIP_TEXT calls the wrapper with coalesceKey ("text:" + clipId).
- CLIP_DRAG_START opens { kind: "drag", key: "drag:" + clipId, before: context.timeline }; a still-open text burst settles first. CLIP_DRAG_MOVE changes only the timeline; it never touches history. CLIP_DRAG_END settles against the gesture baseline and clears the drag state.
- ADD_MEDIA_CLIP changes nothing; the probe-done landing is the only commit point. Probe failure records nothing.
- UNDO: null result is a safe no-op. While a drag is open the event is ignored, because pointer moves would fight the restore. Otherwise settle the text burst, take undoStep, project through resolveTimeline (selection reconciles by the existing dead-selection rule), and clamp time to the restored composition end. REDO mirrors it.
- Selection, playhead seeks, panel/tool/grid chrome and converter trim are outside the snapshot; they stay undo-invisible because no action that touches them calls the wrapper. Availability mirrors the events: canUndo is true while a text burst is open (the undo settles and takes it), false while a drag is open, otherwise past.length > 0; canRedo is false while a drag is open, otherwise future.length > 0.
- Journal resets to emptyJournal() at resetFile, loading-onDone, and the ready/done LOAD_FILE paths. CLEAR flows through resetFile.

Keyboard: the keyboardActor adds Cmd/Ctrl+Z -> UNDO, Cmd/Ctrl+Shift+Z -> REDO, and plain Ctrl+Y -> REDO, with preventDefault when handled and the existing INPUT/TEXTAREA/BUTTON/SELECT skip unchanged, so typing in the clip input keeps native text undo.

TopBar gains Undo and Redo buttons wired through useFluxcutActions().undo()/redo(), disabled by the canUndo/canRedo selectors. The facade sends exactly one event per call.

## Verification

Three levers, all rerunnable:
- `scripts/check-history.mjs` mirrors check-timeline.mjs and proves the pure journal: rejected/same-register pairs record nothing, coalescing settles once, equivalence drops net-zero gestures, undo/redo ordering, redo branch discard, cap eviction, empty-journal no-ops.
- `scripts/check-machine.mjs` drives the real statechart with Node type stripping (a two-line module hook appends .ts to extensionless relative imports) and DOM stubs, then asserts through created actors and real events: a committed edit is undoable and redoable, a rejected edit leaves history untouched, empty UNDO is a no-op, drags collapse to one step (including a fully-rejected drag), text bursts coalesce, and resets empty the journal.
- UI walkthrough on the dev server: buttons enable and disable, clicks step the timeline, shortcuts fire.

## Out of scope (accepted tradeoffs, do not add)

Trim changes, selection history, playhead history, redo across file loads, persistence.

## Synthesis decision

Base: candidate A's snapshot journal, single machine wrapper, drag bracketing on the existing gesture events, and text coalescing with machine-observable boundaries. Its wrapper also keeps the machine diff small; rubric criterion 3 favored A 5-3 on interface depth and its text-boundary rule survived the judge's reliability test.

Grafts from candidate B:
- The single optional open slot as a discriminated union, so "one open transaction at a time" is structural.
- Selection is never snapshotted; resolveTimeline reconciles after undo/redo, exactly as B argued.
- Endpoint equivalence (timelinesEquivalent) so a net-zero drag or burst records nothing.

Rejected from candidate B: the TEXT_EDIT_END event, because it makes the component remember to send blur, a two-file contract that one boundary change breaks. Rejected from candidate A: selection snapshots, for scope symmetry with AGENTS.md.

Gaps the judge named, and the resolutions:
- Cap policy: cap 100 inside registerEdit.
- Machine-level rerunnable check: check-machine.mjs closes it.
- Playhead after undo: clamp to the restored composition end.
- Transient states: UNDO/REDO stay available outside the drag gesture; the probe landing is the single media commit point.
- Keyboard suppresses browser undo with preventDefault.

## Tradeoffs accepted

- We accept whole-timeline snapshots in exchange for no inverse-command logic; assets shared by reference keep entries small.
- We accept burst coalescing that waits for an explicit boundary in exchange for deterministic, timer-free behavior.
- We accept selection loss after undoing a delete in exchange for keeping selection outside history.
- We accept a 100-entry cap and oldest-first eviction in exchange for bounded memory.

## Alternatives considered

- Inverse-command journal. Loses because every helper needs a paired inverse and async adds need bespoke compensation.
- Full-context snapshots. Loses because playhead, chrome and trim would become undoable by accident.
- Wall-clock burst timers. Loses because they make coalescing nondeterministic and machine-external.

## Open questions

- Whether 100 is the right cap. Revisit after real use; the number lives in one place.
- Whether timelineEquivalent should also compare assets. Files cannot change during a gesture today, so it does not.
