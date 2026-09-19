// Takes docs/screenshot.png from a REAL run: a headless Chrome is driven over
// the DevTools protocol against the dev server + runtime you already have up.
// Nothing is mocked — the model answers, the MCP servers answer, the cards are
// what the UI drew. Re-run it whenever the UI changes.
//
//   npm run dev:server & npm run dev:web &   (with a real mcp-chat.config.json)
//   node tools/screenshot.mjs
//
// Env: CHROME (path to chrome.exe / google-chrome), UI (default http://localhost:5173),
//      QUESTIONS (JSON array of strings; defaults below).
// Needs Node 22+ (global WebSocket). The runtime itself runs on 20.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
// vite binds "localhost", which on some hosts is ::1 only — do not write 127.0.0.1 here.
const UI = process.env.UI ?? "http://localhost:5173";
const PORT = 9222 + Math.floor(Math.random() * 500);
// One question that needs two tools is the whole point; a second turn only
// scrolls the first card off the frame.
const QUESTIONS = process.env.QUESTIONS ? JSON.parse(process.env.QUESTIONS) : [
  "How many open HPD violations does 1520 Sedgwick Avenue in the Bronx have, and who is registered as its owner?",
];
const OUT = "docs/screenshot.png";

const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, "--remote-allow-origins=*",
  "--window-size=1000,470", "--hide-scrollbars", "--no-first-run", "--user-data-dir=" + process.env.TEMP + "/mcp-chat-shot",
  "about:blank",
], { stdio: "ignore" });
const cleanup = () => { try { chrome.kill(); } catch {} };
process.on("exit", cleanup);

async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("chrome did not expose a page target");
}

const ws = new WebSocket(await target());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = (m) => { const j = JSON.parse(m.data); if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } };
const send = (method, params = {}) => new Promise((res, rej) => {
  const n = ++id; pending.set(n, (j) => j.error ? rej(new Error(`${method}: ${j.error.message}`)) : res(j.result));
  ws.send(JSON.stringify({ id: n, method, params }));
});
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
await send("Page.navigate", { url: UI });
for (let i = 0; i < 100 && !(await evaluate(`!!document.querySelector('.pill--up')`)); i++) await sleep(200);
if (!(await evaluate(`!!document.querySelector('.pill--up')`))) {
  const state = await evaluate(`JSON.stringify({ href: location.href, ready: document.readyState, text: document.body.innerText.slice(0, 300) })`);
  throw new Error(`no MCP server came up; check the runtime. page: ${state}`);
}

for (const q of QUESTIONS) {
  await evaluate(`(() => {
    const ta = document.querySelector('textarea');
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, ${JSON.stringify(q)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(100);
  await evaluate(`document.querySelector('button[type=submit]').click()`);
  await sleep(500);
  // busy until the textarea is re-enabled (done frame received)
  let done = false;
  for (let i = 0; i < 240 && !done; i++) { await sleep(1000); done = await evaluate(`!document.querySelector('textarea').disabled`); }
  if (!done) throw new Error(`turn did not finish in 240s: ${q}`);
  const text = await evaluate(`document.querySelector('.log').innerText`);
  console.log(`--- ${q}\n${text.split("\n").slice(-6).join("\n")}`);
}
// Size the frame to the transcript: the answer's length varies run to run, and
// a fixed window either leaves a third of the frame empty or cuts the answer.
const need = await evaluate(`(() => {
  const h = (sel) => document.querySelector(sel).offsetHeight;
  return Math.ceil(document.querySelector('.log').scrollHeight + h('.bar') + h('.composer') + 28);
})()`);
await send("Emulation.setDeviceMetricsOverride", { width: 1000, height: Math.min(Math.max(need, 360), 1400), deviceScaleFactor: 1, mobile: false });
await sleep(300);
// the log scrolls itself to the newest frame; the shot wants the question first
await evaluate(`document.querySelector('.log').scrollTop = 0`);
await sleep(400);
const { data } = await send("Page.captureScreenshot", { format: "png" });
mkdirSync("docs", { recursive: true });
writeFileSync(OUT, Buffer.from(data, "base64"));
console.log(`wrote ${OUT}`);
ws.close();
cleanup();
process.exit(0);
