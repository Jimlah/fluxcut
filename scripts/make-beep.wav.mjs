#!/usr/bin/env node
// One-time test asset: a 3s mono 16-bit 22.05 kHz 440 Hz tone at low level for
// the browser audio suite. Regenerate: node scripts/make-beep.wav.mjs
import { writeFileSync, existsSync } from "node:fs";

const OUT = "public/samples/beep.wav";
if (existsSync(OUT)) {
  console.log("EXISTS " + OUT);
  process.exit(0);
}
const rate = 22050;
const seconds = 3;
const amp = 0.25;
const pcm = Buffer.alloc(2 * rate * seconds);
for (let i = 0; i < rate * seconds; i++) {
  pcm.writeInt16LE(Math.round(amp * 32767 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
}
const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write("WAVE", 8);
header.write("fmt ", 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(rate, 24);
header.writeUInt32LE(rate * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(pcm.length, 40);
writeFileSync(OUT, Buffer.concat([header, pcm]));
console.log("WROTE " + OUT + " (" + (44 + pcm.length) + " bytes)");
