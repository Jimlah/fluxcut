#!/usr/bin/env node
// Strict browser audio suite: the real app in headless Chrome. Adds an audio
// clip through the real file-pick flow, then asserts the audio engine's
// graphs, ducking targets, keyframe-driven gain, mixer node params, and one
// live playback read against the machine state (the dev hook pins targets
// exactly; the live read closes the loop through the running context).
// Run: node scripts/browser-audio.mjs (after scripts/make-beep.wav.mjs)
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { withBrowser, lever } from "./lib/browser.mjs";

const DUCK = 0.25;
const BEEP = resolve(process.cwd(), "public/samples/beep.wav");
if (!existsSync(BEEP)) throw new Error("run scripts/make-beep.wav.mjs first");

const { session, close } = await withBrowser("http://127.0.0.1:{port}/");
const lv = lever("browserAudio");

const click = async (x, y) => {
  await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
  await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0 });
};
const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const clickEl = async (expr) => {
  // Panel content sits inside a scrollable body: scroll the target to center
  // first so the click coordinates land in the visible viewport. Small settle
  // delays after state-changing clicks keep React commits from racing the
  // next coordinate probe.
  const b = await session.eval(
    "(function(){ var el = " + expr + "; el.scrollIntoView({ block: 'center' });" +
    " var r = el.getBoundingClientRect().toJSON();" +
    " return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()"
  );
  await click(Math.round(b.x), Math.round(b.y));
  await settle(150);
};
// React controlled range: native value setter + bubble
const setRangeAt = async (index, value) => {
  const landed = await session.eval(
    "(function(){ var el = document.querySelectorAll('.panel-body input[type=range]')[" + index + "];" +
    " if (!el) return false; var set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;" +
    " set.call(el, " + value + "); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()"
  );
  if (!landed) throw new Error("range input " + index + " missing");
  await settle(150);
};
const toggleAt = async (index) => {
  const els = await session.eval("document.querySelectorAll('.mixer-toggle').length");
  if (els <= index) throw new Error("mixer toggle " + index + " missing (have " + els + ")");
  await clickEl("document.querySelectorAll('.mixer-toggle')[" + index + "]");
};
const snap = () => session.eval("window.__FLUXCUT_MIX__.snapshot()");

// 1. boot + hook presence
const bootOk = await session.waitFor("document.querySelectorAll('.lane-track .clip-body').length >= 1", { timeoutMs: 30000 });
await lv.check("app boots with the sample timeline", async () => {
  if (!bootOk) throw new Error("live lanes never appeared");
});
await lv.check("the dev mix hook exposes engine state", async () => {
  const first = await snap();
  if (typeof first !== "object" || !first.targets) throw new Error("__FLUXCUT_MIX__ missing");
});

// 2. the main video runs one neutral graph
const first = await snap();
const videoClipIds = Object.keys(first.targets);
await lv.check("the main video clip runs a neutral Web Audio graph", async () => {
  if (first.nodes !== 1 || videoClipIds.length !== 1) throw new Error("graphs=" + first.nodes);
  const p = first.params[videoClipIds[0]];
  if (first.targets[videoClipIds[0]] !== 1) throw new Error("video target " + first.targets[videoClipIds[0]]);
  if (p.hp !== 20 || p.thr !== 0 || p.ratio !== 1) throw new Error("neutral params " + JSON.stringify(p));
});

// 3. add an audio clip through the real pick flow
let audioId = null;
let panelOpen = false;
await lv.check("adding an audio clip mounts its graph, ducked to -12 dB under the video", async () => {
  await clickEl("document.querySelectorAll('.lane-add-btn')[3]");
  const laneOk = await session.waitFor("document.querySelectorAll('.lane-head').length === 2", { timeoutMs: 10000 });
  if (!laneOk) throw new Error("audio lane never appeared");
  await clickEl("document.querySelectorAll('.lane-head')[1].querySelector('.lane-btn[title^=Pick]')");
  const doc = await session.send("DOM.getDocument", { depth: 1 });
  const node = await session.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "input[type=file]" });
  if (!node.nodeId) throw new Error("file input missing");
  await session.send("DOM.setFileInputFiles", { files: [BEEP], nodeId: node.nodeId });
  const mounted = await session.waitFor("window.__FLUXCUT_MIX__.snapshot().nodes === 2", { timeoutMs: 15000 });
  if (!mounted) throw new Error("audio graph never mounted");
  const now = await snap();
  audioId = Object.keys(now.targets).find((id) => !videoClipIds.includes(id));
  if (!audioId) throw new Error("audio graph id not found");
  const t = now.targets[audioId];
  if (Math.abs(t - DUCK) > 1e-6) throw new Error("ducked target " + t + " want " + DUCK);
});

// 4. select the audio clip, open the mix tool, flip the track's duck policy
await lv.check("the panel duck toggle un-ducks and re-ducks the audio lane", async () => {
  await clickEl("document.querySelectorAll('.lane-track')[1].querySelector('.clip-body')");
  await clickEl("document.querySelectorAll('.rail .circle-btn')[4]");
  panelOpen = await session.waitFor("!!document.querySelector('.panel-body .mixer-toggle')", { timeoutMs: 6000 });
  if (!panelOpen) throw new Error("mixer panel never opened");
  await toggleAt(3); // duck under dialogue -> off (this lane becomes dialogue)
  let t = (await snap()).targets[audioId];
  if (Math.abs(t - 1) > 1e-6) throw new Error("after un-ducking target " + t + " want 1");
  await toggleAt(3);
  t = (await snap()).targets[audioId];
  if (Math.abs(t - DUCK) > 1e-6) throw new Error("after re-ducking target " + t + " want " + DUCK);
});

// 5. keyframe at the playhead drives the ducked gain to its value
await lv.check("a keyframe at the playhead drives the ducked gain to its value", async () => {
  await clickEl("document.querySelectorAll('.mixer-btn:not(.ghost)')[0]");
  // rows: volume + keyframe + 3 eq bands + compression = 6
  const ranges = await session.waitFor("document.querySelectorAll('.panel-body input[type=range]').length === 6", { timeoutMs: 6000 });
  if (!ranges) throw new Error("keyframe row slider missing");
  await setRangeAt(1, 0);
  const t = (await snap()).targets[audioId];
  if (Math.abs(t) > 1e-6) throw new Error("target " + t + " want 0 (0.25 duck x 0 envelope)");
});

// 6. EQ, compression and cleanup params land on the right nodes
await lv.check("EQ, compressor and cleanup params reach the audio graph", async () => {
  await toggleAt(0); // EQ on
  await setRangeAt(3, 6); // mid band
  await toggleAt(1); // compression on
  await toggleAt(2); // cleanup on
  const p = (await snap()).params[audioId];
  if (Math.abs(p.mid - 6) > 1e-6) throw new Error("mid band " + p.mid);
  if (Math.abs(p.thr - -23) > 1e-6) throw new Error("compressor threshold " + p.thr + " want -23");
  if (Math.abs(p.ratio - 7.5) > 1e-6) throw new Error("compressor ratio " + p.ratio + " want 7.5");
  if (p.hp !== 90) throw new Error("high-pass " + p.hp + " want 90");
});

// 7. the dialogue clip's volume slider lifts only its own graph
await lv.check("the dialogue clip volume applies to its own graph", async () => {
  await clickEl("document.querySelector('.lane-track').querySelector('.clip-body')");
  await setRangeAt(0, 1.5);
  const now = await snap();
  if (Math.abs(now.targets[videoClipIds[0]] - 1.5) > 1e-6) throw new Error("video target " + now.targets[videoClipIds[0]]);
  if (Math.abs(now.targets[audioId]) > 1e-6) throw new Error("audio target disturbed: " + now.targets[audioId]);
});

// 8. live playback: the context runs and the gains chase their targets
await lv.check("live playback settles the gains within 20% of their targets", async () => {
  // Click a point of the stage that is inside the viewport (the compositor
  // can extend past the window edge in a short viewport).
  const p = await session.eval(
    "(function(){ var r = document.querySelector('.compositor').getBoundingClientRect().toJSON();" +
    " return { x: Math.round(Math.min(r.x + r.width / 2, window.innerWidth - 120))," +
    " y: Math.round(Math.min(Math.max(60, r.y + 80), window.innerHeight - 60)) }; })()"
  );
  await click(p.x, p.y); // gesture: play
  const started = await session.waitFor("window.__FLUXCUT_MIX__.snapshot().state === 'running'", { timeoutMs: 5000 });
  if (!started) throw new Error("audio context never started (play not running)");
  const rb0 = (await snap()).rebuilds;
  await new Promise((r) => setTimeout(r, 1500));
  const now = await snap();
  const v = now.gains[videoClipIds[0]];
  const a = now.gains[audioId];
  // The per-tick churn regression: graphs must not rebuild while playing.
  if (now.rebuilds !== rb0) throw new Error("graph rebuilt during playback (" + rb0 + " -> " + now.rebuilds + ")");
  if (Math.abs(v - 1.5) > 0.3) throw new Error("live video gain " + v + " want ~1.5");
  if (Math.abs(a) > 0.1) throw new Error("live audio gain " + a + " want ~0 (keyframe x duck)");
  await click(p.x, p.y); // pause
});

// 9. reset wipes the mix through the panel
await lv.check("reset restores the clip defaults", async () => {
  await clickEl("document.querySelector('.mixer-btn.ghost')");
  const t = (await snap()).targets[videoClipIds[0]];
  if (Math.abs(t - 1) > 1e-6) throw new Error("post-reset target " + t + " want 1");
});

console.log("DONE browser-audio");
await close();
lv.exit();