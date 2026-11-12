#!/usr/bin/env node
// Lever for the pure mixer math: keyframe envelopes, the duck factor ramps
// (including the min rule over overlapping dialogue), and the final per-clip
// table. Run: node scripts/check-audio-mix.mjs
import {
  DUCK_AMOUNT,
  DUCK_ATTACK_SEC,
  DUCK_RELEASE_SEC,
  duckFactor,
  envelope,
  mixGain,
} from "../src/lib/audio.ts";
import { setClipMix, setTrackDuck, upsertClipKeyframe } from "../src/lib/timeline.ts";
import { defaultMix } from "../src/lib/timeline.ts";

let failures = 0;
const close = (a, b, what, eps = 1e-9) => {
  if (Math.abs(a - b) > eps) throw new Error(what + ": got " + a + ", want " + b);
};
const ok = (cond, what) => {
  if (!cond) throw new Error(what);
};
const check = (name, fn) => {
  try {
    fn();
    console.log("PASS " + name);
  } catch (error) {
    failures += 1;
    console.log("FAIL " + name + " - " + error.message);
  }
};

const mix = (over) => ({ ...defaultMix(), ...over });

// ---- envelope ----

check("envelope: no keyframes is unity", () => {
  close(envelope(mix({ keyframes: [] }), 0), 1, "empty curve");
});

check("envelope: constant before the first and after the last point", () => {
  const kfs = [{ t: 1, g: 0.5 }, { t: 3, g: 1.5 }];
  close(envelope(mix({ keyframes: kfs }), 0), 0.5, "held the first value left of the curve");
  close(envelope(mix({ keyframes: kfs }), 1), 0.5, "at the first point");
  close(envelope(mix({ keyframes: kfs }), 5), 1.5, "held the last value right of the curve");
  close(envelope(mix({ keyframes: kfs }), 3), 1.5, "at the last point");
});

check("envelope: linear between neighbors", () => {
  const kfs = [{ t: 0, g: 0 }, { t: 4, g: 2 }];
  close(envelope(mix({ keyframes: kfs }), 2), 1, "midpoint");
  close(envelope(mix({ keyframes: kfs }), 1), 0.5, "quarter");
  close(envelope(mix({ keyframes: kfs }), 3.5), 1.75, "three quarters");
});

// ---- duck factor ----

const tv = (id, duck, clips) => ({ id, kind: "video", name: id, duck, clips });
const ta = (id, duck, clips) => ({ id, kind: "audio", name: id, duck, clips });
const vclip = (id, start, dur) => ({ id, kind: "video", start, duration: dur, assetId: "a", sourceStart: 0, speed: 1, mix: defaultMix() });
const aclip = (id, start, dur) => ({ id, kind: "audio", start, duration: dur, assetId: "a", sourceStart: 0, speed: 1, mix: defaultMix() });

check("duckFactor: 1 with no dialogue sources", () => {
  const tracks = [ta("music", true, [aclip("m", 0, 10)])];
  close(duckFactor(tracks, 5), 1, "a lone ducker should not duck itself");
  close(duckFactor([], 5), 1, "empty track list");
  const imageTrack = [{ id: "ti", kind: "image", name: "ti", clips: [] }];
  close(duckFactor(imageTrack, 5), 1, "non-sound track acted as dialogue");
});

check("duckFactor: DUCK_AMOUNT inside the dialogue window, unity far away", () => {
  const tracks = [tv("speech", false, [vclip("s", 2, 4)])];
  close(duckFactor(tracks, 0), 1, "far before the window");
  close(duckFactor(tracks, 7), 1, "far after the window (window is 2..6)");
  close(duckFactor(tracks, 3), DUCK_AMOUNT, "inside the window");
  close(duckFactor(tracks, 2), DUCK_AMOUNT, "at the window start");
  close(duckFactor(tracks, 1.99), DUCK_AMOUNT + (1 - DUCK_AMOUNT) * 0.25, "10ms before the start sits inside the 40ms attack");
});

check("duckFactor: the attack ramp is linear over DUCK_ATTACK", () => {
  const tracks = [tv("speech", false, [vclip("s", 2, 4)])];
  close(duckFactor(tracks, 2 - DUCK_ATTACK_SEC), 1, "ramp start");
  close(duckFactor(tracks, 2 - DUCK_ATTACK_SEC / 2), 1 - (1 - DUCK_AMOUNT) * 0.5, "ramp midpoint");
});

check("duckFactor: the release ramp is linear over DUCK_RELEASE", () => {
  const tracks = [tv("speech", false, [vclip("s", 2, 4)])];
  close(duckFactor(tracks, 6 + DUCK_RELEASE_SEC), 1, "release end (unity at exactly RELEASE)");
  close(duckFactor(tracks, 6 + DUCK_RELEASE_SEC / 2), 1 - (1 - DUCK_AMOUNT) * 0.5, "release midpoint");
  close(duckFactor(tracks, 7), 1, "one second after release (unity again)");
});

check("duckFactor: overlapping dialogue windows stay ducked to the min rule", () => {
  const tracks = [
    tv("speech", false, [vclip("s1", 2, 2)]),
    tv("speech2", false, [vclip("s2", 5, 2)]),
  ];
  close(duckFactor(tracks, 4), DUCK_AMOUNT, "at the first window end the second starts before the next start");
  close(duckFactor(tracks, 4.55), 1, "past the release tail of the first window"); // 0.55 after the end, RELEASE is 0.5
  const overlap = [
    tv("a", false, [vclip("a1", 2, 4)]),
    ta("b", false, [aclip("b1", 3, 4)]),
  ];
  close(duckFactor(overlap, 5), DUCK_AMOUNT, "two overlapping dialogue tracks");
  close(duckFactor(overlap, 7), DUCK_AMOUNT, "inside the second window");
  close(duckFactor(overlap, 7.25), 0.625, "release tail only from the later window end");
  close(duckFactor(overlap, 7.5), 1, "unity at exactly one DUCK_RELEASE past the last end");
});

// ---- mixGain over whole timelines ----

const tlOf = (tracks, assets = { a: videoAsset() }) => ({ tracks, assets, primaryVideoClipId: "s" });
const videoAsset = () => ({ id: "a", kind: "video", name: "a", url: "u:a", duration: 10, w: 16, h: 9, poster: "" });

check("mixGain: dialogue tracks take the envelope, duckers also take the duck factor", () => {
  let tl = tlOf([
    tv("speech", false, [vclip("s", 0, 10)]),
    ta("music", true, [aclip("m", 0, 8)]),
  ]);
  tl = upsertClipKeyframe(tl, "s", 0, 0.5);
  tl = upsertClipKeyframe(tl, "s", 10, 1.5);
  const atZero = mixGain(tl, 0);
  const dialogue = mixGain(tl, 4);
  close(dialogue.get("s"), 0.5 + ((1.5 - 0.5) * 4) / 10, "dialogue envelope midpoint (replaces the removed line)");
  close(atZero.get("s"), 0.5, "dialogue clip ignored its envelope");
  close(atZero.get("m"), DUCK_AMOUNT, "music gain ignored the duck factor while dialogue runs");
  const atFour = mixGain(tl, 4);
  close(atFour.get("s"), 0.5 + ((1.5 - 0.5) * 4) / 10, "dialogue envelope midpoint");
  close(atFour.get("m"), DUCK_AMOUNT, "ducked audio clip during dialogue");
  const settled = mixGain(tl, 10.6);
  close(settled.get("m"), 1, "music gain after the dialogue release window");
  close(settled.get("s"), 1.5, "dialogue clip holds its last envelope value");
});

check("mixGain: baseline volume multiplies the keyframe curve", () => {
  let tl = tlOf([tv("speech", false, [vclip("s", 0, 10)])]);
  tl = setClipMix(tl, "s", { gain: 1.5 });
  tl = upsertClipKeyframe(tl, "s", 0, 1);
  tl = upsertClipKeyframe(tl, "s", 5, 0.5);
  tl = upsertClipKeyframe(tl, "s", 10, 1);
  close(mixGain(tl, 0).get("s"), 1.5, "baseline x first keyframe");
  close(mixGain(tl, 2.5).get("s"), 1.5 * 0.75, "baseline x interp");
  close(mixGain(tl, 10).get("s"), 1.5 * 1, "baseline x last keyframe");
});

check("mixGain: a toggled ducker changes its own factor and the ducking decision", () => {
  let tl = tlOf([
    tv("speech", false, [vclip("s", 0, 10)]),
    ta("music", true, [aclip("m", 0, 8)]),
  ]);
  const before = mixGain(tl, 4).get("m");
  close(before, DUCK_AMOUNT, "music ducked while dialogue runs");
  const toggled = setTrackDuck(tl, "music_track", false);
  ok(!toggled, "setTrackDuck accepted a wrong track id");
  const unmuted = setTrackDuck(tl, "music", false);
  if (!unmuted) throw new Error("track duck toggle rejected");
  close(mixGain(unmuted, 4).get("m"), 1, "music unmuted once its track became dialogue");
  close(mixGain(unmuted, 4).get("s"), 1, "dialogue clip stays at baseline under the toggle");
});

if (failures > 0) process.exit(1);
console.log("check:audio-mix - all checks passed");