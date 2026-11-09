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

const version = await (await fetch(CDP_BASE + "/json/version")).json();
const targets = await (await fetch(CDP_BASE + "/json/list")).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("no page target");
const cdp = await connect(page.webSocketDebuggerUrl);
const failures = [];
const consoleErrors = [];
cdp.on((msg) => {
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    consoleErrors.push(`EXCEPTION ${d.text} ${d.exception?.description || ""}`.slice(0, 600));
  }
  if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params.type)) {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    consoleErrors.push(`CONSOLE ${msg.params.type.toUpperCase()} ${text}`.slice(0, 500));
  }
  if (msg.method === "Network.loadingFailed" && !msg.params.canceled) {
    failures.push(`${msg.params.errorText} ${msg.params.blockedReason || ""}`.trim());
  }
});
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Network.enable");
await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
await cdp.send("Page.navigate", { url: APP });
await sleep(1600);
await evaluate("localStorage.clear()");
await cdp.send("Page.navigate", { url: APP + "?q=" + encodeURIComponent("上海外滩") + "&radius=3000&bookable=1" });

async function evaluate(expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || ""));
  return r.result?.value;
}
async function waitFor(expression, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await evaluate(expression)) return true; } catch {}
    await sleep(250);
  }
  return false;
}
async function shot(name) {
  const r = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  writeFileSync(OUT + name, Buffer.from(r.data, "base64"));
  return name;
}

await waitFor("document.querySelectorAll('.hotel-card').length > 0", 25000);
await sleep(1800);
const home = await evaluate(`JSON.stringify({
  cards: document.querySelectorAll('.hotel-card').length,
  clusters: document.querySelectorAll('.price-cluster').length,
  markers: document.querySelectorAll('.price-marker').length,
  tiles: document.querySelectorAll('.leaflet-tile-loaded').length,
  imgLoaded: [...document.querySelectorAll('.card-thumb img')].filter(i => i.naturalWidth > 0).length,
  scrollWidth: document.documentElement.scrollWidth,
  innerWidth: window.innerWidth,
  mapChip: document.querySelector('#mapChip')?.textContent,
  circlePath: (() => { const p = document.querySelector('.leaflet-overlay-pane path'); if (!p) return null; const r = p.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), stroke: p.getAttribute('stroke'), fill: p.getAttribute('fill') }; })(),
  stats: document.querySelector('#statBar')?.innerText.replace(/\\s+/g, ' ').slice(0, 160)
})`);
console.log("HOME", home);
await shot("home.png");

await evaluate("document.querySelector('.hotel-card')?.click()");
await waitFor("document.querySelector('#drawer')?.classList.contains('open')", 5000);
await sleep(1200);
const drawer = await evaluate(`JSON.stringify({
  open: document.querySelector('#drawer').classList.contains('open'),
  title: document.querySelector('#drawerInner h2')?.textContent,
  rooms: document.querySelectorAll('.room-card').length,
  reviews: document.querySelectorAll('.review-card').length,
  gallery: document.querySelectorAll('.gallery-item').length,
  scrollHeight: document.querySelector('#drawerInner')?.scrollHeight,
  clientHeight: document.querySelector('#drawerInner')?.clientHeight,
  heroLoaded: [...document.querySelectorAll('.d-hero img')].every(i => i.naturalWidth > 0)
})`);
console.log("DRAWER", drawer);
await shot("detail.png");

await evaluate(`(() => { const s = [...document.querySelectorAll('.d-section')].find(x => x.innerText.includes('住客评论')); if (s) s.scrollIntoView({block:'start'}); return !!s; })()`);
await sleep(700);
await shot("reviews.png");

await evaluate("document.querySelector('.gallery-item')?.click()");
await waitFor("!document.querySelector('#lightbox')?.hidden", 4000);
await sleep(900);
const lightbox = await evaluate(`JSON.stringify({
  open: !document.querySelector('#lightbox').hidden,
  imgLoaded: document.querySelector('#lightboxImg')?.naturalWidth > 0,
  caption: document.querySelector('#lightboxCaption')?.innerText?.slice(0, 100),
  active: document.activeElement?.className
})`);
console.log("LIGHTBOX", lightbox);
await shot("lightbox.png");

await evaluate("document.querySelector('#lightboxClose')?.click()");
await sleep(300);
await evaluate("document.querySelector('#drawer .d-close')?.click()");
await sleep(500);

await evaluate(`(() => {
  const q = document.querySelector('#query');
  q.focus(); q.value = '杭州西湖';
  q.dispatchEvent(new Event('input', { bubbles: true }));
  return q.value;
})()`);
await sleep(1800);
const suggest = await evaluate(`JSON.stringify({
  visible: !document.querySelector('#suggestBox').hidden,
  items: [...document.querySelectorAll('.suggest-item .s-name')].map(x => x.textContent).slice(0, 8)
})`);
console.log("SUGGEST", suggest);
await shot("suggest.png");

await evaluate(`(() => {
  const q = document.querySelector('#query');
  q.value = '杭州西湖';
  q.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#searchBtn').click();
  return true;
})()`);
await waitFor(`document.querySelector('#resultTitle')?.textContent.includes('西湖') || document.querySelector('#resultSub')?.textContent.includes('西湖')`, 25000);
await sleep(1600);
const second = await evaluate(`JSON.stringify({
  title: document.querySelector('#resultTitle')?.textContent,
  sub: document.querySelector('#resultSub')?.textContent,
  cards: document.querySelectorAll('.hotel-card').length,
  clusters: document.querySelectorAll('.price-cluster').length,
  mapChip: document.querySelector('#mapChip')?.textContent,
  first: document.querySelector('.hotel-card .card-name')?.textContent,
  firstPrice: document.querySelector('.hotel-card .card-price')?.innerText?.slice(0, 60)
})`);
console.log("SECOND", second);
await shot("hangzhou.png");

console.log("CONSOLE_ERRORS", JSON.stringify(consoleErrors.slice(0, 12), null, 2));
console.log("NETWORK_FAILURES", JSON.stringify([...new Set(failures)].slice(0, 20), null, 2));
cdp.close();
