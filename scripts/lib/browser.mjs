#!/usr/bin/env node
// Minimal CDP driver for the browser levers. Launches headless Chrome with a
// scratch profile, opens a page, evaluates async expressions, kills Chrome on
// close. No dependencies: the global WebSocket (Node 22+) is the transport.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

/** An OS-assigned free port; races are unlikely and strictPort makes them loud. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

const CHROME =
  process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

class CdpSession {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #handlers = new Map();

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener("close", (ev) => {
      if (process.env.CDP_DEBUG) console.log("[cdp] ws closed", ev.code, ev.reason ?? "");
    });
    ws.addEventListener("open", () => { if (process.env.CDP_DEBUG) console.log("[cdp] ws open"); });
    ws.addEventListener("message", (ev) => {
      if (process.env.CDP_DEBUG) console.log("[cdp] <<", String(ev.data).slice(0, 300));
      const msg = JSON.parse(String(ev.data));
      if (msg.id != null) {
        const settle = this.#pending.get(msg.id);
        if (settle) {
          this.#pending.delete(msg.id);
          if (msg.error) settle.reject(new Error(msg.error.message));
          else settle.resolve(msg.result);
        }
      } else if (msg.method) {
        for (const h of this.#handlers.get(msg.method) ?? []) h(msg.params);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.#nextId++;
    // Flat (flatten: true) sessions carry sessionId at the message's top level.
    const msg = JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params });
    this.#ws.send(msg);
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error("CDP timeout: " + method));
        }
      }, 15000);
    });
  }

  on(method, handler) {
    if (!this.#handlers.has(method)) this.#handlers.set(method, []);
    this.#handlers.get(method).push(handler);
  }

  close() {
    this.#ws.close();
  }
}

/**
 * Start the vite dev server, then headless Chrome pointed at it.
 * Returns { session, pageId, chrome, vite, close } — call close() to kill both.
 * session.eval(expression) resolves to the JSON return value.
 */
export async function withBrowser(pageUrl, { port, onViteStdout } = {}) {
  const chosen = port ?? (await freePort());
  const url = pageUrl.replace(/\{port\}/g, String(chosen));
  const vite = spawn(process.execPath, [
    "node_modules/vite/bin/vite.js",
    "--port", String(chosen),
    "--strictPort",
    "--host", "127.0.0.1",
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  const viteOut = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("vite did not start in 20s")), 20000);
    vite.stdout.on("data", (d) => {
      const s = String(d);
      viteOut.push(s);
      onViteStdout?.(s);
      if (s.includes("127.0.0.1:" + chosen) || s.includes("localhost:" + chosen)) {
        clearTimeout(timer);
        resolve();
      }
    });
    vite.stderr.on("data", (d) => viteOut.push(String(d)));
    vite.on("exit", (code) => reject(new Error("vite exited early (" + code + "): " + viteOut.join(""))));
  });

  const profile = mkdtempSync(join(tmpdir(), "fluxcut-lever-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    // This environment can neither init the Chrome sandbox nor the GPU process;
    // headless + software GL + no sandbox is the standard CI combination.
    "--no-sandbox",
    "--disable-gpu",
    "--use-angle=swiftshader",
    "--mute-audio",
    "--user-data-dir=" + profile,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const stderr = [];
  chrome.stderr.on("data", (d) => {
    stderr.push(String(d));
    if (process.env.CDP_DEBUG) console.log("[chrome] " + String(d).trim());
  });
  chrome.on("exit", (code, signal) => {
    if (process.env.CDP_DEBUG) console.log("[chrome] exit", code, signal);
  });
  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("chrome did not open CDP: " + stderr.join(""))), 20000);
    const pat = /DevTools listening on (ws:\/\/\S+)/;
    const tick = setInterval(() => {
      const m = stderr.join("").match(pat);
      if (m) { clearInterval(tick); clearTimeout(timer); resolve(m[1]); }
    }, 50);
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve); ws.addEventListener("error", reject); });
  const session = new CdpSession(ws);

  const target = await session.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await session.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const rawSend = session.send.bind(session);
  const scopedSend = (method, params = {}) => rawSend(method, params, sessionId);
  session.send = scopedSend;

  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("Page.navigate", { url });

  session.eval = async (expression) => {
    const r = await session.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error("eval failed: " + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    }
    return r.result?.value;
  };
  session.waitFor = async (predicateExpr, { timeoutMs = 15000 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ok = await session.eval(predicateExpr).catch(() => false);
      if (ok) return true;
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  async function close() {
    try { session.close(); } catch { /* socket already gone */ }
    try { chrome.kill("SIGKILL"); } catch { /* already gone */ }
    try { vite.kill("SIGKILL"); } catch { /* already gone */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* scratch profile */ }
  }

  return { session, targetId: target.targetId, chrome, vite, viteOut, close };
}

/** One PASS/FAIL line per check, exits 1 when anything failed. */
export function lever() {
  let failures = 0;
  return {
    check: async (what, fn) => {
      try {
        await fn();
        console.log("PASS " + what);
      } catch (error) {
        failures += 1;
        console.log("FAIL " + what + " - " + (error?.message ?? error));
      }
    },
    exit: () => process.exit(failures ? 1 : 0),
  };
}