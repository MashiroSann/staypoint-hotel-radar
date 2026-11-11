import { writeFileSync } from "node:fs";

const CDP_BASE = "http://127.0.0.1:9222";
const APP = "http://127.0.0.1:8765/";
const OUT = "G:\\workdir\\staypoint\\screenshots\\";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    const listeners = [];
    let seq = 0;
    ws.onopen = () => resolve({
      send(method, params = {}) {
        const id = ++seq;
        return new Promise((res, rej) => {
          pending.set(id, { res, rej, method });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      on(fn) { listeners.push(fn); },
      close() { ws.close(); },
    });
    ws.onerror = (event) => reject(new Error("WebSocket error: " + (event.message || "unknown")));
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(`${p.method}: ${msg.error.message}`));
        else p.res(msg.result);
      } else {
        listeners.forEach((fn) => fn(msg));
      }
    };
  });
}

const targets = await (await fetch(CDP_BASE + "/json/list")).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("no page target");
const cdp = await connect(page.webSocketDebuggerUrl);
const errors = [];
cdp.on((msg) => {
  if (msg.method === "Runtime.exceptionThrown") {
    errors.push(`EXCEPTION ${msg.params.exceptionDetails.text} ${msg.params.exceptionDetails.exception?.description || ""}`.slice(0, 500));
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    errors.push(`CONSOLE ${msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`.slice(0, 400));
  }
});
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });

async function evaluate(expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || ""));
  return r.result?.value;
}
async function waitFor(expression, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await evaluate(expression)) return true; } catch {}
    await sleep(300);
  }
  return false;
}
async function shot(name) {
  const r = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  writeFileSync(OUT + name, Buffer.from(r.data, "base64"));
}

// 1. 首页：应停在欢迎页，不自动搜索
await cdp.send("Page.navigate", { url: APP });
await sleep(1800);
await evaluate("localStorage.clear()");
await cdp.send("Page.navigate", { url: APP });
await sleep(2200);
const boot = await evaluate(`JSON.stringify({
  input: document.querySelector('#query')?.value,
  cards: document.querySelectorAll('.hotel-card').length,
  welcome: !!document.querySelector('.welcome-card'),
  url: location.search,
  title: document.querySelector('#resultTitle')?.textContent
})`);
console.log("BOOT", boot);
await shot("boot-empty.png");

// 2. 杭州站 10km
await evaluate(`(() => {
  const q = document.querySelector('#query');
  q.value = '杭州站';
  q.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#radius').value = '10000';
  document.querySelector('#radius').dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
await sleep(300);
await evaluate("document.querySelector('#searchBtn').click()");
const ok = await waitFor("document.querySelectorAll('.hotel-card').length > 5", 40000);
await sleep(2200);
const result = await evaluate(`JSON.stringify({
  ok: ${ok},
  cards: document.querySelectorAll('.hotel-card').length,
  clusters: document.querySelectorAll('.price-cluster').length,
  markers: document.querySelectorAll('.price-marker').length,
  mapChip: document.querySelector('#mapChip')?.textContent,
  sub: document.querySelector('#resultSub')?.textContent,
  stats: document.querySelector('#statBar')?.innerText.replace(/\\s+/g, ' ').slice(0, 200),
  footer: document.querySelector('#footerCount')?.textContent,
  maxDist: Math.max(...[...document.querySelectorAll('.hotel-card .chip-dist')].map(e => {
    const t = e.textContent.trim();
    return t.includes('公里') ? parseFloat(t) * 1000 : parseFloat(t);
  })),
  circle: (() => { const p = document.querySelector('.leaflet-overlay-pane path'); if (!p) return null; const r = p.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()
})`);
console.log("SEARCH", result);
await shot("hangzhou-10km.png");

// 3. 定位一家远处酒店，验证地图能到外圈
const far = await evaluate(`(() => {
  const cards = [...document.querySelectorAll('.hotel-card')];
  const target = cards[cards.length - 1];
  target.querySelector('.card-locate')?.click();
  return target.querySelector('.card-name')?.textContent;
})()`);
await sleep(2600);
const located = await evaluate(`JSON.stringify({
  farHotel: ${JSON.stringify(far)},
  tip: document.querySelector('.hotel-map-tip')?.innerText?.replace(/\\s+/g, ' '),
  selected: document.querySelector('.hotel-card.selected .card-name')?.textContent
})`);
console.log("LOCATE", located);
await shot("locate-far.png");

console.log("ERRORS", JSON.stringify(errors.slice(0, 8)));
cdp.close();
