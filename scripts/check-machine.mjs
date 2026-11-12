#!/usr/bin/env node
// Lever for the Fluxcut statechart: drives the REAL machine (Node type
// stripping + minimal DOM stubs) through events and asserts the undo/redo
// wiring on actor snapshots. One PASS line per check; a failure names the
// broken step and the process exits 1. Run: node scripts/check-machine.mjs

// The resolve hook must exist before machine.ts resolves its extensionless
// relative imports, so this is the first static import and machine.ts is
// only imported dynamically below.
import "./machine-check-hooks.mjs";
import { createActor, waitFor } from "xstate";

globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };

// loadVideoMeta / probeMedia decode through DOM media elements. The fake
// <video> reports loadedmetadata (5s, 640x360) or error on demand, and the
// fake <canvas> yields no 2d context so the filmstrip returns [] early.
let videoEvent = "loadedmetadata";
globalThis.document = {
  createElement: (tag) => {
    if (tag === "video") {
      return {
        preload: "",
        muted: false,
        src: "",
        duration: 5,
        videoWidth: 640,
        videoHeight: 360,
        addEventListener(type, cb) {
          if (type === videoEvent) queueMicrotask(() => cb());
        },
        removeAttribute() {},
        load() {},
      };
    }
    if (tag === "canvas") return { width: 0, height: 0, getContext: () => null };
    return null;
  },
};
globalThis.Image = class {
  naturalWidth = 16;
  naturalHeight = 9;
  set src(_) {
    queueMicrotask(() => this.onload?.());
  }
};

const { fluxcutMachine } = await import("../src/lib/machine.ts");

let failures = 0;

const ok = (cond, what) => {
  if (!cond) throw new Error(what);
};
const check = async (name, fn) => {
  try {
    await fn();
    console.log('PASS ' + name);
  } catch (error) {
    failures += 1;
    console.log('FAIL ' + name + ' - ' + error.message);
  }
};

const start = () => {
  const actor = createActor(fluxcutMachine);
  actor.start();
  return actor;
};
const ctx = (actor) => actor.getSnapshot().context;
// The drag element is never pointer-driven here; the machine gets MOVE/END directly.
const dragEl = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 20 }) };
const makeFile = (name) => new File([new Uint8Array([1])], name, { type: "video/mp4" });

const textClipFixture = (actor) => {
  actor.send({ type: "ADD_TRACK", kind: "text" });
  const trackId = ctx(actor).timeline.tracks[0].id;
  actor.send({ type: "ADD_TEXT_CLIP", trackId });
  return ctx(actor).timeline.tracks[0].clips[0].id;
};
const textOf = (tl, clipId) => {
  for (const t of tl.tracks) {
    const c = t.clips.find((k) => k.id === clipId);
    if (c) return c.text;
  }
  return null;
};

await check("committed edit: ADD_TRACK books an entry that UNDO restores and REDO replays", async () => {
  const actor = start();
  const pre = ctx(actor).timeline;
  actor.send({ type: "ADD_TRACK", kind: "video" });
  ok(ctx(actor).history.past.length === 1, "committed edit did not book an entry");
  const entry = ctx(actor).history.past[0];
  ok(entry.before === pre && entry.after === ctx(actor).timeline, "entry did not bracket the commit");
  actor.send({ type: "UNDO" });
  ok(ctx(actor).timeline === pre, "UNDO did not restore the pre-edit timeline");
  ok(ctx(actor).history.past.length === 0 && ctx(actor).history.future.length === 1, "UNDO did not move the entry to future");
  actor.send({ type: "REDO" });
  ok(ctx(actor).timeline === entry.after, "REDO did not replay the committed timeline");
  ok(ctx(actor).history.past.length === 1 && ctx(actor).history.future.length === 0, "REDO left the stacks unbalanced");
});

await check("rejected edit: a sub-MIN_CLIP_SEC CUT_CLIP leaves journal and timeline untouched", async () => {
  const actor = start();
  const clipId = textClipFixture(actor);
  const snapshot = ctx(actor);
  actor.send({ type: "CUT_CLIP", clipId, time: 0.05 });
  ok(ctx(actor).history === snapshot.history, "a rejected edit touched the journal");
  ok(ctx(actor).timeline === snapshot.timeline, "a rejected edit rebased the timeline");
  actor.send({ type: "SET_CLIP_SPEED", clipId, speed: 2 });
  actor.send({ type: "MOVE_TRACK", trackId: "ghost-track", dir: 1 });
  ok(ctx(actor).history === snapshot.history, "another rejected edit touched the journal");
});

await check("no-op edit: REMOVE_TRACK on an unknown id keeps the journal and the redo branch", async () => {
  const actor = start();
  actor.send({ type: "ADD_TRACK", kind: "video" });
  actor.send({ type: "UNDO" });
  const journal = ctx(actor).history;
  actor.send({ type: "REMOVE_TRACK", trackId: "ghost-track" });
  ok(ctx(actor).history === journal, "a no-op edit touched the journal");
  ok(ctx(actor).history.future.length === 1, "a no-op edit killed the redo branch");
  actor.send({ type: "REDO" });
  ok(ctx(actor).timeline.tracks.length === 1, "REDO lost the undone track");
});

await check("drag gesture: a full drag records exactly one entry", async () => {
  const actor = start();
  const clipId = textClipFixture(actor);
  const baseline = ctx(actor).timeline;
  const pastCount = ctx(actor).history.past.length;
  actor.send({ type: "CLIP_DRAG_START", clipId, mode: "move", time: 0, element: dragEl, seconds: 20 });
  const open = ctx(actor).history.open;
  ok(open && open.kind === "drag" && open.key === "drag:" + clipId && open.before === baseline, "drag start did not bracket its baseline");
  actor.send({ type: "CLIP_DRAG_MOVE", time: 2 });
  actor.send({ type: "CLIP_DRAG_MOVE", time: 4 });
  actor.send({ type: "CLIP_DRAG_END" });
  const c = ctx(actor);
  ok(c.history.past.length === pastCount + 1, "drag did not collapse to one entry");
  ok(c.history.open === null, "drag end left a transaction open");
  ok(c.timeline.tracks[0].clips[0].start === 4, "drag moves did not land at 4s");
  const entry = c.history.past[c.history.past.length - 1];
  ok(entry.before === baseline && entry.after === c.timeline, "drag entry bracketed the wrong pair");
});

await check("drag gesture: a fully-rejected drag records nothing", async () => {
  const actor = start();
  const clipId = textClipFixture(actor);
  const before = ctx(actor);
  actor.send({ type: "CLIP_DRAG_START", clipId, mode: "slip", time: 0, element: dragEl, seconds: 20 });
  actor.send({ type: "CLIP_DRAG_MOVE", time: 5 });
  actor.send({ type: "CLIP_DRAG_MOVE", time: 8 });
  actor.send({ type: "CLIP_DRAG_END" });
  const after = ctx(actor);
  ok(after.history.past.length === before.history.past.length, "a rejected drag recorded an entry");
  ok(after.history.open === null, "a rejected drag left a transaction open");
  ok(after.timeline === before.timeline, "a rejected drag changed the timeline");
});

await check("drag gesture: a net-zero drag (out and back) records nothing", async () => {
  const actor = start();
  const clipId = textClipFixture(actor);
  actor.send({ type: "CLIP_DRAG_START", clipId, mode: "move", time: 0, element: dragEl, seconds: 20 });
  actor.send({ type: "CLIP_DRAG_MOVE", time: 3 });
  actor.send({ type: "CLIP_DRAG_MOVE", time: 0 });
  actor.send({ type: "CLIP_DRAG_END" });
  const c = ctx(actor);
  ok(c.history.past.length === 2, "a net-zero drag recorded an entry");
  ok(c.history.open === null, "a net-zero drag left a transaction open");
});

await check("text burst: three SET_CLIP_TEXT events coalesce to one entry at settle", async () => {
  const actor = start();
  const clipId = textClipFixture(actor);
  const pastCount = ctx(actor).history.past.length;
  actor.send({ type: "SET_CLIP_TEXT", clipId, text: 'h' });
  const open = ctx(actor).history.open;
  ok(open && open.kind === "text" && open.key === "text:" + clipId, "the first keystroke did not open a burst");
  ok(ctx(actor).history.past.length === pastCount, "the first keystroke recorded an entry");
  ok(textOf(ctx(actor).timeline, clipId) === 'h', 'the first keystroke did not project');
  actor.send({ type: "SET_CLIP_TEXT", clipId, text: 'he' });
  actor.send({ type: "SET_CLIP_TEXT", clipId, text: 'hello' });
  ok(ctx(actor).history.past.length === pastCount, "a keystroke recorded an entry");
  ok(textOf(ctx(actor).timeline, clipId) === 'hello', 'keystrokes did not project the text');
  actor.send({ type: "SELECT_CLIP", clipId: null });
  const c = ctx(actor);
  ok(c.history.past.length === pastCount + 1, "the burst did not settle to exactly one entry");
  const entry = c.history.past[c.history.past.length - 1];
  ok(textOf(entry.before, clipId) === '' && textOf(entry.after, clipId) === 'hello', 'the burst entry did not bracket the text change');
});

await check("empty journal: UNDO and REDO change nothing", async () => {
  const actor = start();
  const snapshot = ctx(actor);
  actor.send({ type: "UNDO" });
  ok(ctx(actor).history === snapshot.history && ctx(actor).timeline === snapshot.timeline, "an empty UNDO disturbed the context");
  actor.send({ type: "REDO" });
  ok(ctx(actor).history === snapshot.history && ctx(actor).timeline === snapshot.timeline, "an empty REDO disturbed the context");
});

await check("media landing: the probe-done commit books one entry and selects the placed clip", async () => {
  videoEvent = "loadedmetadata";
  const actor = start();
  actor.send({ type: "LOAD_FILE", file: makeFile("main.mp4") });
  await waitFor(actor, (s) => s.matches("ready"), { timeout: 2000 });
  actor.send({ type: "ADD_TRACK", kind: "image" });
  const trackId = ctx(actor).timeline.tracks.find((t) => t.kind === "image").id;
  const pastCount = ctx(actor).history.past.length;
  actor.send({ type: "REQUEST_PICK_TRACK_MEDIA", trackId });
  actor.send({ type: "ADD_MEDIA_CLIP", trackId, file: new File([new Uint8Array([1])], "x.png", { type: "image/png" }) });
  await waitFor(actor, (s) => s.context.timeline.tracks.some((t) => t.kind === "image" && t.clips.length === 1), { timeout: 2000 });
  const c = ctx(actor);
  ok(c.history.past.length === pastCount + 1, "the media landing did not record exactly one entry");
  const lane = c.timeline.tracks.find((t) => t.kind === "image");
  ok(c.selectedClipId === lane.clips[0].id, "the media landing did not select the placed clip");
});

await check("load then edit then CLEAR: resetFile empties the journal", async () => {
  videoEvent = "loadedmetadata";
  const actor = start();
  actor.send({ type: "LOAD_FILE", file: makeFile("ok.mp4") });
  await waitFor(actor, (s) => s.matches("ready"), { timeout: 2000 });
  actor.send({ type: "ADD_TRACK", kind: "text" });
  actor.send({ type: "ADD_TEXT_CLIP", trackId: ctx(actor).timeline.tracks[1].id });
  ok(ctx(actor).history.past.length === 2, "edits after a load did not record");
  actor.send({ type: "CLEAR" });
  const c = ctx(actor);
  ok(c.history.past.length === 0 && c.history.future.length === 0 && c.history.open === null, "CLEAR kept history entries");
  ok(c.timeline.tracks.length === 0, "CLEAR kept timeline tracks");
});

await check("LOAD_FILE from ready: the journal resets before the probe finishes", async () => {
  videoEvent = "loadedmetadata";
  const actor = start();
  actor.send({ type: "LOAD_FILE", file: makeFile("first.mp4")});
  await waitFor(actor, (s) => s.matches("ready"), { timeout: 2000 });
  actor.send({ type: "ADD_TRACK", kind: "text" });
  ok(ctx(actor).history.past.length === 1, "the edit after a load did not record");
  videoEvent = "none";
  actor.send({ type: "LOAD_FILE", file: makeFile("pending.mp4") });
  await waitFor(actor, (s) => s.matches("loading"), { timeout: 2000 });
  ok(ctx(actor).history.past.length === 0, "LOAD_FILE from ready did not reset the journal upfront");
});

await check("failed load: resetFile empties the journal (the same action CLEAR uses)", async () => {
  videoEvent = "error";
  const actor = start();
  actor.send({ type: "ADD_TRACK", kind: "text" });
  actor.send({ type: "ADD_TRACK", kind: "video" });
  ok(ctx(actor).history.past.length === 2, "the setup edits did not record");
  actor.send({ type: "LOAD_FILE", file: makeFile("bad.mp4") });
  await waitFor(actor, (s) => s.matches("empty") && s.context.error !== "", { timeout: 2000 });
  const c = ctx(actor);
  ok(c.history.past.length === 0 && c.history.open === null, "a failed load left history entries");
  ok(c.timeline.tracks.length === 0, "a failed load kept timeline tracks");
});

if (failures > 0) process.exit(1);
console.log("check:machine - all checks passed");
