#!/usr/bin/env node
// Lever for the snapshot journal: runs the pure history helpers against
// hand-built Timeline fixtures. One PASS line per check; a failure names the
// broken step and the process exits 1. Run: node scripts/check-history.mjs
import {
  canRedo,
  canUndo,
  emptyJournal,
  openTransaction,
  redoStep,
  registerEdit,
  settleTransaction,
  timelinesEquivalent,
  undoStep,
} from "../src/lib/history.ts";

let failures = 0;

const ok = (cond, what) => {
  if (!cond) throw new Error(what);
};
const check = (name, fn) => {
  try {
    fn();
    console.log('PASS ' + name);
  } catch (error) {
    failures += 1;
    console.log('FAIL ' + name + ' - ' + error.message);
  }
};

const tclip = (id, start, dur, text = "") => ({ id, kind: "text", start, duration: dur, text });
const vclip = (id, start, dur, assetId, sourceStart = 0, speed = 1) => ({
  id, kind: "video", start, duration: dur, assetId, sourceStart, speed,
});
const track = (id, kind, clips) => ({ id, kind, name: id, clips });
const tim = (tracks, primary = null) => ({ tracks, assets: {}, primaryVideoClipId: primary });

const tlA = tim([{ ...track("t1", "text", [tclip("c1", 0, 3, "a")]) }]);
const tlB = tim([{ ...track("t1", "text", [tclip("c1", 0, 3, "b")]) }]);
const tlC = tim([{ ...track("t1", "text", [tclip("c1", 0, 3, "c")]) }]);
const tlD = tim([{ id: "t1", kind: "image", name: "t1", clips: [{ id: "c1", kind: "image", start: 0, duration: 3, assetId: "a1" }] }]);

const textBurst = (key = "text:c1", before = tlA) =>
  openTransaction(emptyJournal(), { kind: "text", key, before });

check("registerEdit: pushes a closed step, drops the future branch, keeps order", () => {
  const journal = { ...emptyJournal(), future: [{ before: tlC, after: tlD }] };
  const first = registerEdit(journal, tlA, tlB);
  ok(first.past.length === 1, "entry count changed on register");
  ok(first.past[0].before === tlA && first.past[0].after === tlB, "entry kept the wrong endpoints");
  ok(first.future.length === 0, "registerEdit kept the future branch");
  const second = registerEdit(first, tlB, tlC);
  ok(second.past.length === 2 && second.past[0].before === tlA && second.past[1].after === tlC, "oldest-first order broke");
  ok(second.past[0].after === tlB && second.past[1].before === tlB, "adjacent entries disagree about the shared timeline");
});

check("undoStep/redoStep: pop the newest step and restore the right endpoint", () => {
  let journal = registerEdit(registerEdit(emptyJournal(), tlA, tlB), tlB, tlC);
  let step = undoStep(journal);
  if (!step) throw new Error("undo on a two-entry past returned null");
  ok(step.timeline === tlB, "first undo restored the wrong timeline");
  ok(step.journal.future.length === 1 && step.journal.future[0].after === tlC, "undo did not move the top entry to future");
  ok(step.journal.past.length === 1, "undo did not pop the past");
  step = undoStep(step.journal);
  if (!step) throw new Error("second undo returned null");
  ok(step.timeline === tlA, "second undo restored the wrong timeline");
  step = redoStep(step.journal);
  if (!step) throw new Error("redo on a one-entry future returned null");
  ok(step.timeline === tlB, "redo replayed the wrong step");
  step = redoStep(step.journal);
  if (!step) throw new Error("second redo returned null");
  ok(step.timeline === tlC && step.journal.past.length === 2 && step.journal.future.length === 0, "redo did not rebalance the stacks");
});

check("registerEdit: a commit after undo clears the redo branch", () => {
  const undone = undoStep(registerEdit(emptyJournal(), tlA, tlB));
  if (!undone) throw new Error("undo on a single edit returned null");
  ok(undone.journal.future.length === 1, "undo left nothing to redo");
  const edited = registerEdit(undone.journal, tlA, tlD);
  ok(edited.future.length === 0, "commit kept the redo branch");
  ok(redoStep(edited) === null, "redo survived a commit");
  ok(edited.past.length === 1 && edited.past[0].after === tlD, "commit recorded the wrong entry");
});

check("settleTransaction: pushes a changed endpoint as one entry and clears future", () => {
  const settled = settleTransaction(textBurst("text:c1", tlA), tlB);
  ok(settled.open === null, "settle left a transaction open");
  ok(settled.past.length === 1 && settled.past[0].before === tlA && settled.past[0].after === tlB, "settled burst entries broke");
  ok(settled.future.length === 0, "settled burst kept the future branch");
});

check("settleTransaction: a same-reference settle returns the journal untouched", () => {
  const journal = { ...emptyJournal(), future: [{ before: tlC, after: tlD }] };
  ok(settleTransaction(journal, tlB) === journal, "settle without an open transaction rebuilt the journal");
});

check("settleTransaction: drops an equivalent endpoint and keeps the future branch", () => {
  const journal = { ...emptyJournal(), future: [{ before: tlC, after: tlD }] };
  const sameRef = settleTransaction(openTransaction(journal, { kind: "drag", key: "drag:c1", before: tlA }), tlA);
  ok(sameRef.past.length === 0, "same-reference settle recorded an entry");
  ok(sameRef.open === null && sameRef.future.length === 1, "same-reference settle broke the future branch or left a transaction open");
  const copy = tim([{ ...track("t1", "text", [{ ...tclip("c1", 0, 3, "a") }]) }]);
  const valueEqual = settleTransaction(openTransaction(journal, { kind: "drag", key: "drag:c1", before: tlA }), copy);
  ok(valueEqual.past.length === 0 && valueEqual.open === null, "value-equivalent settle recorded an entry");
  ok(valueEqual.future.length === 1, "value-equivalent settle broke the future branch");
});

check("text burst: one open slot settles once however many keystrokes landed", () => {
  const reopened = openTransaction(textBurst(), { kind: "text", key: "text:c1", before: tlA });
  ok(reopened.open !== null && reopened.past.length === 0, "reopening the burst recorded an entry");
  const settled = settleTransaction(reopened, tlB);
  ok(settled.past.length === 1, "burst recorded more than one entry");
  ok(settleTransaction(settled, tlC) === settled, "a settled burst settled again into a second entry");
});

check("openTransaction: keeps the stacks and replaces the open slot", () => {
  const journal = { ...emptyJournal(), future: [{ before: tlC, after: tlD }] };
  const drag = openTransaction(journal, { kind: "drag", key: "drag:c1", before: tlA });
  ok(drag.open?.kind === "drag" && drag.past.length === 0 && drag.future.length === 1, "opening a transaction disturbed the stacks");
  const swapped = openTransaction(drag, { kind: "text", key: "text:c1", before: tlB });
  ok(swapped.open?.kind === "text" && swapped.open.key === "text:c1", "reopening swapped the wrong open slot");
});

check("cap: registerEdit keeps at most 100 entries evicting the oldest first", () => {
  const states = Array.from({ length: 106 }, (_, n) => tim([track("t1", "text", [tclip("c1", 0, 3, "v" + n)])]));
  let journal = emptyJournal();
  for (let i = 0; i < 105; i++) journal = registerEdit(journal, states[i], states[i + 1]);
  ok(journal.past.length === 100, "cap exceeded: got " + journal.past.length);
  ok(journal.past[0].before === states[5] && journal.past[0].after === states[6], "eviction dropped the wrong end");
  ok(journal.past[99].after === states[105], "eviction lost the newest entry");
  const step = undoStep(journal);
  if (!step) throw new Error("undo at the cap returned null");
  ok(step.journal.past.length === 99 && step.journal.future.length === 1, "undo at the cap did not rebalance");
});

check("empty journal: undo/redo are safe no-ops and can* read the stacks", () => {
  const journal = emptyJournal();
  ok(undoStep(journal) === null, "undo fired on an empty past");
  ok(redoStep(journal) === null, "redo fired on an empty future");
  ok(!canUndo(journal) && !canRedo(journal), "canUndo/canRedo true on an empty journal");
  const undone = undoStep(registerEdit(emptyJournal(), tlA, tlB));
  if (!undone) throw new Error("undo on a single edit returned null");
  ok(!canUndo(undone.journal), "canUndo stayed true with an empty past");
  ok(canRedo(undone.journal), "canRedo stayed false with a pending redo");
  const replayed = redoStep(undone.journal);
  if (!replayed) throw new Error("redo returned null");
  ok(canUndo(replayed.journal) && !canRedo(replayed.journal), "can* flags broke after a replay");
});

check("canUndo/canRedo mirror what the events do: burst undoable, drag blocks", () => {
  const burst = textBurst();
  ok(canUndo(burst), "an open text burst stayed unundoable");
  ok(!canRedo(burst), "an open text burst claimed a redo without a future");
  const dragOpen = openTransaction(emptyJournal(), { kind: "drag", key: "drag:c1", before: tlA });
  const blocked = { past: [{ before: tlA, after: tlB }], future: [{ before: tlA, after: tlB }], open: dragOpen.open };
  ok(!canUndo(blocked), "UNDO claims a step a drag in flight would ignore");
  ok(!canRedo(blocked), "REDO claims a step a drag in flight would ignore");
  const cleared = { ...blocked, open: null };
  ok(canUndo(cleared) && canRedo(cleared), "settled stacks lost their availability");
});

check("timelinesEquivalent: equal values match across distinct objects", () => {
  ok(timelinesEquivalent(tlA, tim([{ ...track("t1", "text", [{ ...tclip("c1", 0, 3, "a") }]) }])), "deep-equal copies compared unequal");
  ok(timelinesEquivalent(tlA, { ...tlA, assets: { a1: tlD.tracks[0].clips[0] } }), "asset contents broke equivalence");
  ok(timelinesEquivalent(tlD, tim([{ id: "t1", kind: "image", name: "renamed", clips: [{ id: "c1", kind: "image", start: 0, duration: 3, assetId: "a1" }] }])), "a renamed track broke equivalence");
});

check("timelinesEquivalent: any clip value, structure or primary change breaks it", () => {
  const differs = (other, what) => ok(!timelinesEquivalent(tlA, other), what + " compared equal");
  differs(tlB, "a text change");
  differs(tim([{ ...track("t1", "text", [{ ...tclip("c1", 0, 3, "a"), id: "c2" }]) }]), "a clip id change");
  differs(tim([{ ...track("t1", "text", [{ ...tclip("c1", 0.5, 3, "a") }]) }]), "a start change");
  differs(tim([{ ...track("t1", "text", [{ ...tclip("c1", 0, 2.5, "a") }]) }]), "a duration change");
  differs(tim([{ ...track("t1", "text", [tclip("c1", 0, 3, "a"), tclip("c2", 3, 3, "b")] ) }]), "a clip count change");
  differs(tim([{ ...track("t2", "text", [tclip("c1", 0, 3, "a")]) }]), "a track id change");
  differs(tim([track("t1", "text", [tclip("c1", 0, 3, "a")]), track("t2", "text", [])]), "a track count change");
  differs(tim([track("t1", "video", [{ ...vclip("c1", 0, 3, "a1", 0), }]), ]), "a track kind change");
  const video = tim([track("t1", "video", [vclip("c1", 0, 3, "a1")])], "c1");
  differs(video, tim([track("t1", "video", [vclip("c1", 0, 3, "a1", 1)])]), "a sourceStart change");
  differs(video, tim([track("t1", "video", [{ ...vclip("c1", 0, 3, "a1"), speed: 2 }])]), "a speed change");
  differs(video, tim([track("t1", "video", [{ ...vclip("c1", 0, 3, "a2") }])]), "an assetId change");
  differs(video, tim([track("t1", "video", [vclip("c1", 0, 3, "a1")])]), "a primaryVideoClipId change");
  differs({ ...tlA, primaryVideoClipId: "ghost" }, tlA, "a dangling primary change");
});

if (failures > 0) process.exit(1);
console.log("check:history - all checks passed");
