#!/usr/bin/env node
// Browser lever: boots the real app in headless Chrome through the vite dev
// server and checks the composition stage against what the machine loaded.
// Baseline run proves the harness on the pre-change app. Post-change, the
// audio suite (scripts/browser-audio.mjs) rides the same driver.
// Run: node scripts/browser-smoke.mjs
import { withBrowser, lever } from "./lib/browser.mjs";

const { session, close } = await withBrowser("http://127.0.0.1:{port}/");

const lv = lever("browserSmoke");

await lv.check("app boots", async () => {
  const booted = await session.waitFor("document.getElementById('root')?.children.length >= 1", { timeoutMs: 10000 });
  if (!booted) throw new Error("empty root after 10s");
});

// The app auto-fetches the vendored sample; the probe + filmstrip pass can take
// a few seconds, so wait for the live multi-track view rather than the demo strip.
const loadedOk = await session.waitFor(
  "document.querySelectorAll('.lane-track .clip-body').length >= 1",
  { timeoutMs: 30000 }
);

await lv.check("sample timeline loads one clip on a live lane", async () => {
  if (!loadedOk) throw new Error("live lanes never appeared after 30s");
});

await lv.check("stage mounts a compositor layer", async () => {
  const n = await session.eval("document.querySelectorAll('.comp-layer').length");
  if (!(n >= 1)) throw new Error("layers=" + n);
});

console.log("DONE browser-smoke");
await close();
lv.exit();
