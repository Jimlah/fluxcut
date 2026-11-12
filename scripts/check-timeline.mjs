#!/usr/bin/env node
// Lever for the timeline domain: runs the pure helpers against hand-built
// fixtures. One PASS line per check; a failure message names the broken step
// and the process exits 1. Run: node scripts/check-timeline.mjs
import {
  MIN_CLIP_SEC,
  SPEED_PRESETS,
  compositionEnd,
  compToSource,
  sourceToComp,
  deleteClip,
  findClip,
  planClipDrag,
  rippleDeleteClip,
  setClipSpeed,
  splitClip,
} from "../src/lib/timeline.ts";

let failures = 0;

const ok = (cond, what) => {
  if (!cond) throw new Error(what);
};
const close = (a, b, what) => ok(Math.abs(a - b) < 1e-9, what + ": got " + a + ", want " + b);
const check = (name, fn) => {
  try {
    fn();
    console.log('PASS ' + name);
  } catch (error) {
    failures += 1;
    console.log('FAIL ' + name + ' - ' + error.message);
  }
};

const videoAsset = (id, dur) => ({ id, kind: "video", name: id, url: "u:" + id, duration: dur, w: 16, h: 9, poster: "" });
const audioAsset = (id, dur) => ({ id, kind: "audio", name: id, url: "u:" + id, duration: dur });
const imageAsset = (id) => ({ id, kind: "image", name: id, url: "u:" + id, w: 16, h: 9 });
const vclip = (id, start, dur, assetId, sourceStart = 0, speed = 1) => ({ id, kind: "video", start, duration: dur, assetId, sourceStart, speed });
const aclip = (id, start, dur, assetId, sourceStart = 0, speed = 1) => ({ id, kind: "audio", start, duration: dur, assetId, sourceStart, speed });
const iclip = (id, start, dur, assetId) => ({ id, kind: "image", start, duration: dur, assetId });
const tclip = (id, start, dur, text = "") => ({ id, kind: "text", start, duration: dur, text });
const track = (id, kind, clips) => ({ id, kind, name: id, clips });
const tim = (tracks, assets, primary = null) => ({ tracks, assets, primaryVideoClipId: primary });

const clip = (tl, id) => findClip(tl, id);

function assertInvariants(tl, label) {
  for (const t of tl.tracks) {
    const sorted = [...t.clips].sort((a, b) => a.start - b.start);
    sorted.forEach((c, i) => {
      if (c.duration < MIN_CLIP_SEC) throw new Error(label + ": " + c.id + " below MIN_CLIP_SEC (" + c.duration + ")");
      const prev = i > 0 ? sorted[i - 1] : null;
      if (prev && c.start < prev.start + prev.duration) throw new Error(label + ": overlap " + prev.id + " / " + c.id);
      if (c.kind === "video" || c.kind === "audio") {
        const asset = tl.assets[c.assetId];
        if (!asset) throw new Error(label + ": " + c.id + " has no asset");
        if (c.sourceStart < 0 || c.sourceStart + c.duration * c.speed > asset.duration + 1e-3) {
          throw new Error(label + ": " + c.id + " leaves its source window");
        }
        if (c.speed < 0.25 || c.speed > 8) throw new Error(label + ": " + c.id + " speed " + c.speed + " out of range");
      } else if ("assetId" in c && !tl.assets[c.assetId]) {
        throw new Error(label + ": " + c.id + " has no asset");
      }
    });
  }
  let end = 0;
  for (const t of tl.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.duration);
  if (Math.abs(end - compositionEnd(tl)) > 1e-9) {
    throw new Error(label + ": compositionEnd " + compositionEnd(tl) + " != recomputed " + end);
  }
  if (tl.primaryVideoClipId && !clip(tl, tl.primaryVideoClipId)) {
    throw new Error(label + ": primaryVideoClipId names a dead clip");
  }
}

// fixtures
const a10 = videoAsset("a10", 10);
const run1 = () => tim([track("t1", "video", [vclip("c1", 0, 10, "a10")])], { a10 }, "c1");
const run2x = () => tim([track("t1", "video", [vclip("c1", 0, 5, "a10", 0, 2)])], { a10 }, "c1");

check("SPEED_PRESETS: presets bracket the retime range", () => {
  close(SPEED_PRESETS[0], 0.25, "slowest preset");
  close(SPEED_PRESETS[SPEED_PRESETS.length - 1], 8, "fastest preset");
  ok(SPEED_PRESETS.length === 7, "expected 7 presets, got " + SPEED_PRESETS.length);
  ok(SPEED_PRESETS.some((s) => s === 1), "1x is offered as a preset");
});

check("splitClip: the two pieces are adjacent with the right durations", () => {
  const tl = run1();
  const split = splitClip(tl, "c1", 4);
  if (!split) throw new Error("split at 4 was rejected");
  const pieces = split.timeline.tracks[0].clips;
  if (pieces.length !== 2) throw new Error("expected 2 pieces, got " + pieces.length);
  close(pieces[0].duration, 4, "left piece duration");
  close(pieces[1].start, 4, "right piece start (adjacent)");
  close(pieces[1].duration, 6, "right piece duration");
  ok(pieces[0].id === "c1", "left piece kept the original id");
  ok(pieces[1].id === split.rightClipId, "returned rightClipId matches the right piece");
  close(pieces[1].sourceStart, 4, "right piece sourceStart at speed 1");
  assertInvariants(split.timeline, "split");
});

check("splitClip: at speed 2 the right piece advances sourceStart by elapsed x 2", () => {
  const split = splitClip(run2x(), "c1", 2);
  if (!split) throw new Error("split at 2 was rejected");
  const right = clip(split.timeline, split.rightClipId);
  if (!right) throw new Error("right piece missing");
  close(right.sourceStart, 4, "right sourceStart = 2 comp s x speed 2");
  close(right.duration, 3, "right piece duration");
  close(right.speed, 2, "right piece kept the speed");
  ok(split.timeline.primaryVideoClipId === "c1", "primary reference stays on the left piece");
  close(compToSource(split.timeline, 1), 2, "comp 1 over the primary left piece maps to source 2");
  close(sourceToComp(split.timeline, 4), 2, "source 4 of the left piece maps back to comp 2");
  assertInvariants(split.timeline, "split at 2x");
});

check("splitClip: works for audio, image and text clips", () => {
  const assets = { a10, aud: audioAsset("aud", 10), img: imageAsset("img") };
  const tl = tim([
    track("tv", "video", [aclip("av", 0, 10, "a10")]),
    track("ta", "audio", [aclip("aa", 0, 10, "aud")]),
    track("ti", "image", [iclip("ai", 0, 4, "img")]),
    track("tt", "text", [tclip("at", 0, 4, "hello")]),
  ], assets, "av");
  const audioSplit = splitClip(tl, "aa", 3);
  if (!audioSplit) throw new Error("audio split rejected");
  close(clip(audioSplit.timeline, audioSplit.rightClipId).sourceStart, 3, "audio right piece sourceStart");
  const imageSplit = splitClip(tl, "ai", 2);
  if (!imageSplit) throw new Error("image split rejected");
  ok(!("sourceStart" in clip(imageSplit.timeline, imageSplit.rightClipId)), "image right piece has no sourceStart");
  const textSplit = splitClip(tl, "at", 2);
  if (!textSplit) throw new Error("text split rejected");
  assertInvariants(textSplit.timeline, "split non-media");
});

check("splitClip: rejects pieces below MIN_CLIP_SEC", () => {
  const tl = run1();
  ok(splitClip(tl, "c1", 0.1) === null, "cut 0.1s from the start was accepted");
  ok(splitClip(tl, "c1", 9.9) === null, "cut 0.1s before the end was accepted");
  ok(splitClip(tl, "c1", 0) === null, "cut at the start was accepted");
  ok(splitClip(tl, "c1", 10) === null, "cut at the end was accepted");
  ok(splitClip(tl, "ghost", 5) === null, "cut on an unknown clip was accepted");
});

check("rippleDeleteClip: the gap closes and everything else holds still", () => {
  const tl = tim([
    track("t1", "video", [vclip("c1", 0, 4, "a10"), vclip("c2", 4, 3, "a10"), vclip("c3", 7, 5, "a10", 2)]),
    track("t2", "audio", [aclip("aa", 2, 5, "aud")]),
  ], { a10, aud: audioAsset("aud", 10) }, "c1");
  const rippled = rippleDeleteClip(tl, "c2");
  if (!rippled) throw new Error("ripple of c2 was rejected");
  close(clip(rippled, "c1").start, 0, "earlier clip moved during ripple");
  close(clip(rippled, "c3").start, 4, "later clip shifted by the deleted duration");
  close(clip(rippled, "c3").duration, 5, "later clip duration unchanged");
  ok(!clip(rippled, "c2"), "deleted clip still present");
  const other = clip(rippled, "aa");
  close(other.start, 2, "other track moved during ripple");
  ok(rippled.primaryVideoClipId === "c1", "primary nulled by a non-primary ripple");
  assertInvariants(rippled, "ripple delete");

  const plain = deleteClip(tl, "c2");
  close(clip(plain, "c3").start, 7, "plain delete left the gap (later clip held still)");
});

check("rippleDeleteClip: primary nulls out and unknown ids reject", () => {
  const rippled = rippleDeleteClip(run1(), "c1");
  if (!rippled) throw new Error("ripple of the primary was rejected");
  ok(rippled.primaryVideoClipId === null, "primary survived a primary ripple");
  assertInvariants(rippled, "ripple delete primary");
  ok(rippleDeleteClip(run1(), "ghost") === null, "ripple on an unknown clip was accepted");
});

check("planClipDrag slip: the window holds still while sourceStart moves", () => {
  const tl = tim([track("t1", "video", [vclip("c1", 0, 4, "a10"), vclip("c2", 4, 2, "a10", 4)])], { a10 }, "c1");
  const slipped = planClipDrag(tl, { clipId: "c1", mode: "slip", anchorTime: 5 }, 7);
  if (!slipped) throw new Error("slip delta +2 was rejected");
  const c = clip(slipped, "c1");
  close(c.start, 0, "slip moved the clip in composition time");
  close(c.duration, 4, "slip changed the frame length");
  close(c.sourceStart, 2, "sourceStart advanced by elapsed x speed 1");
  assertInvariants(slipped, "slip");

  const fast = tim([track("t1", "video", [vclip("c1", 0, 4, "a10", 0, 2)])], { a10 }, "c1");
  const sped = planClipDrag(fast, { clipId: "c1", mode: "slip", anchorTime: 0 }, 1);
  if (!sped) throw new Error("slip delta +1 at speed 2 was rejected");
  close(clip(sped, "c1").sourceStart, 2, "sourceStart advanced by elapsed x speed 2");
  close(clip(sped, "c1").duration, 4, "sourceLen stayed at duration x speed");
  assertInvariants(sped, "slip at 2x");
});

check("planClipDrag slip: out-of-range rejects stay reversible", () => {
  const tl = tim([track("t1", "video", [vclip("c1", 0, 4, "a10", 0, 2)])], { a10 }, "c1");
  ok(planClipDrag(tl, { clipId: "c1", mode: "slip", anchorTime: 0 }, 5) === null, "slip past the source end was accepted");
  ok(planClipDrag(tl, { clipId: "c1", mode: "slip", anchorTime: 0 }, -1) === null, "slip before source 0 was accepted");
  ok(planClipDrag(tl, { clipId: "ic", mode: "slip", anchorTime: 0 }, 1) === null, "slip on an image clip was accepted");
});

check("planClipDrag slide: a contiguous run stays contiguous", () => {
  const tl = tim([
    track("t1", "video", [vclip("cL", 0, 2, "a10", 0, 2), vclip("cT", 2, 3, "a10", 4, 2), vclip("cR", 5, 3, "a10", 0, 2)]),
  ], { a10 }, "cT");
  const slid = planClipDrag(tl, { clipId: "cT", mode: "slide", anchorTime: 6 }, 7);
  if (!slid) throw new Error("slide delta +1 across a contiguous run was rejected");
  const left = clip(slid, "cL");
  const target = clip(slid, "cT");
  const right = clip(slid, "cR");
  close(left.start, 0, "left neighbor start moved");
  close(left.duration, 3, "left neighbor stretched to the new seam");
  close(left.sourceStart, 0, "left neighbor sourceStart moved");
  close(target.start, 3, "target start moved by the delta");
  close(target.duration, 3, "target duration moved during slide");
  close(target.sourceStart, 4, "target source window moved during slide");
  close(right.start, 6, "right neighbor fell behind the seam");
  close(right.duration, 2, "right neighbor shrunk by the delta");
  close(right.sourceStart, 2, "right neighbor sourceStart shifted by delta x its own speed");
  close(compositionEnd(slid), 8, "seam slide changed the composition end");
  assertInvariants(slid, "slide");
});

check("planClipDrag slide: rejects a neighbor below MIN_CLIP_SEC", () => {
  const tl = tim([
    track("t1", "video", [vclip("cL", 0, 1, "a10"), vclip("cT", 1, 3, "a10"), vclip("cR", 4, 3, "a10")]),
  ], { a10 }, "cT");
  ok(planClipDrag(tl, { clipId: "cT", mode: "slide", anchorTime: 5 }, 3.95) === null, "slide left the left neighbor under MIN_CLIP_SEC");
  ok(planClipDrag(tl, { clipId: "cT", mode: "slide", anchorTime: 5 }, 8) === null, "slide left the right neighbor under MIN_CLIP_SEC");
});

check("planClipDrag slide: rejects a neighbor outside its source", () => {
  const grow = tim([
    track("t1", "video", [vclip("cL", 0, 2, "a10", 7), vclip("cT", 2, 3, "a10"), vclip("cR", 5, 3, "a10")]),
  ], { a10 }, "cT");
  ok(planClipDrag(grow, { clipId: "cT", mode: "slide", anchorTime: 2 }, 3.5) === null, "growing left neighbor ran past the asset end");
  const push = tim([
    track("t1", "video", [vclip("cL", 0, 2, "a10"), vclip("cT", 2, 3, "a10"), vclip("cR", 5, 3, "a10", 0)]),
  ], { a10 }, "cT");
  ok(planClipDrag(push, { clipId: "cT", mode: "slide", anchorTime: 2 }, 1) === null, "shrinking right neighbor was pushed before source 0");
});

check("planClipDrag slide: a gapped run falls back to move", () => {
  const tl = tim([
    track("t1", "video", [vclip("cL", 0, 1, "a10"), vclip("cT", 2, 3, "a10")]),
  ], { a10 }, "cT");
  const fallback = planClipDrag(tl, { clipId: "cT", mode: "slide", anchorTime: 2 }, 3);
  if (!fallback) throw new Error("slide fallback to move was rejected");
  close(clip(fallback, "cT").start, 3, "fallback moved the loose clip like a plain move");
  close(clip(fallback, "cL").duration, 1, "fallback stretched an untouched neighbor");
  assertInvariants(fallback, "slide fallback");
});

check("setClipSpeed: duration rescales while the source length holds", () => {
  const retimed = setClipSpeed(run1(), "c1", 2);
  if (!retimed) throw new Error("speed 2 on a 10s clip was rejected");
  const c = clip(retimed, "c1");
  close(c.duration, 5, "duration did not rescale by old/new");
  close(c.speed, 2, "speed not stored");
  close(c.duration * c.speed, 10, "source length changed while retiming");
  close(compToSource(retimed, 4), 8, "comp 4 maps to source 8 at 2x");
  close(sourceToComp(retimed, 10), 5, "source 10 maps back to comp 5");
  assertInvariants(retimed, "setClipSpeed 2x");

  const slowed = setClipSpeed(retimed, "c1", 0.5);
  if (!slowed) throw new Error("speed 0.5 was rejected");
  close(clip(slowed, "c1").duration, 20, "slow motion doubled the composition length");
  assertInvariants(slowed, "setClipSpeed 0.5x");
});

check("setClipSpeed: overlap, min-duration, range and non-media reject", () => {
  const tight = tim([track("t1", "video", [vclip("c1", 0, 4, "a10"), vclip("c2", 4, 2, "a10")])], { a10 }, "c1");
  ok(setClipSpeed(tight, "c1", 0.5) === null, "0.5x overlapping the neighbor was accepted");
  const tiny = tim([track("t1", "video", [vclip("c1", 0, 0.4, "a10")])], { a10 }, "c1");
  ok(setClipSpeed(tiny, "c1", 8) === null, "8x leaving a 0.05s clip was accepted");
  ok(setClipSpeed(run1(), "c1", 0.1) === null, "speed 0.1 was accepted");
  ok(setClipSpeed(run1(), "c1", 10) === null, "speed 10 was accepted");
  ok(setClipSpeed(run1(), "c1", NaN) === null, "NaN speed was accepted");
  const mixed = tim([
    track("t1", "text", [tclip("tx", 0, 3, "hello")]),
    track("t2", "image", [iclip("im", 0, 3, "img")]),
  ], { img: imageAsset("img") }, null);
  ok(setClipSpeed(mixed, "tx", 2) === null, "retiming a text clip was accepted");
  ok(setClipSpeed(mixed, "im", 2) === null, "retiming an image clip was accepted");
});

if (failures > 0) process.exit(1);
console.log("check:timeline - all checks passed");
