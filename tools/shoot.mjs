// Real-size screenshots of a page, for reviewing layouts the Browser pane scales
// down too far to judge. Drives headless Edge over the DevTools protocol with
// Node's built-in WebSocket, so it needs no dependency.
//
//   node tools/shoot.mjs <url> <out-dir> <width>x<height> <shot> [<shot> ...]
//
// Each shot opens `<url>?shot=<name>`; the page settles itself on that shot.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, outDir, size, ...shots] = process.argv.slice(2);
const [width, height] = size.split("x").map(Number);
const EDGE = process.env.EDGE ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const port = 9300 + Math.floor(Math.random() * 500);
mkdirSync(outDir, { recursive: true });

const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${port}`, "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader", "--hide-scrollbars", `--user-data-dir=${mkdtempSync(join(tmpdir(), "shoot-"))}`,
  `--window-size=${width},${height}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    target = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).then((l) => l.find((t) => t.type === "page")).catch(() => null);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 768 });
  for (const shot of shots) {
    const sep = url.includes("?") ? "&" : "?";
    await send("Page.navigate", { url: `${url}${sep}shot=${shot}` });
    for (let i = 0; i < 120; i++) { await sleep(500); if (await evalJs("!!window.__spine?.ready")) break; }
    await sleep(1500);
    const info = await evalJs(`JSON.stringify({settle: window.__spine.settle(${JSON.stringify(shot)}), callouts: window.__spine.callouts()})`);
    await sleep(900);
    const shotPng = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(outDir, `${String(shot).replace(/[^a-z0-9.-]/gi, "_")}-${width}x${height}.png`), Buffer.from(shotPng.result.data, "base64"));
    console.log(shot, info);
  }
  ws.close();
} finally {
  edge.kill();
}
