import { writeFileSync } from "node:fs";

const targets = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("no page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  }
};
function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const expression = process.argv[2] || "document.title";
const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
if (result.exceptionDetails) {
  console.error("EXCEPTION", result.exceptionDetails.text, result.exceptionDetails.exception?.description || "");
  process.exitCode = 1;
} else {
  console.log(typeof result.result?.value === "string" ? result.result.value : JSON.stringify(result.result?.value, null, 2));
}
if (process.argv[3]) {
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(process.argv[3], Buffer.from(shot.data, "base64"));
  console.log("screenshot", process.argv[3]);
}
ws.close();
