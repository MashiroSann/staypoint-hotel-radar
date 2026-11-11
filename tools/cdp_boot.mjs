import { writeFileSync } from "node:fs";

const CDP_BASE = "http://127.0.0.1:9222";
const APP = "http://127.0.0.1:8765/";
const OUT = "G:\\workdir\\staypoint\\screenshots\\";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch(CDP_BASE + "/json/list")).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq; pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result?.value;
};
const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  writeFileSync(OUT + name, Buffer.from(r.data, "base64"));
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });

// 1) 先搜一次杭州站，让 localStorage 记下上次查询
await send("Page.navigate", { url: APP + "?q=" + encodeURIComponent("杭州站") + "&radius=10000" });
await sleep(9000);
const first = await evaluate(`JSON.stringify({
  cards: document.querySelectorAll('.hotel-card').length,
  url: location.search,
  ls: Object.keys(localStorage)
})`);
console.log("AFTER_SEARCH", first);

// 2) 模拟“上次搜索过杭州站”后重新打开首页，应停在欢迎页而不是自动搜杭州站
await evaluate("localStorage.setItem('sp_last_query','杭州站'); localStorage.setItem('sp_radius','10000')");
await send("Page.navigate", { url: APP });
await sleep(2500);
const reopen = await evaluate(`JSON.stringify({
  input: document.querySelector('#query')?.value,
  cards: document.querySelectorAll('.hotel-card').length,
  welcome: !!document.querySelector('.welcome-card'),
  radius: document.querySelector('#radius')?.value,
  url: location.search,
  title: document.querySelector('#resultTitle')?.textContent
})`);
console.log("REOPEN", reopen);

// 截图用：清掉本地偏好，回到默认 3 公里的欢迎页
await evaluate("localStorage.clear()");
await send("Page.navigate", { url: APP });
await sleep(2200);
await shot("boot-empty.png");

// 3) 点快速标签应能正常搜索
await evaluate(`document.querySelector('[data-query="北京故宫"]')?.click()`);
await sleep(9000);
const quick = await evaluate(`JSON.stringify({
  cards: document.querySelectorAll('.hotel-card').length,
  title: document.querySelector('#resultTitle')?.textContent,
  url: location.search
})`);
console.log("QUICK", quick);

ws.close();
