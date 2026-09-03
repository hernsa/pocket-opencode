const PORT = 4096;
const USER = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
const PASS = process.env.OPENCODE_SERVER_PASSWORD ?? "";
const AUTH = "Basic " + btoa(`${USER}:${PASS}`);
const DIR = "C:/Users/Admin/Downloads";
const BASE = `http://127.0.0.1:${PORT}`;
const MODEL = { providerID: "opencode", modelID: "nemotron-3.5-lightning-free" };

const created = await fetch(`${BASE}/session?directory=${encodeURIComponent(DIR)}`, {
  method: "POST",
  headers: { authorization: AUTH, "content-type": "application/json" },
  body: JSON.stringify({ title: "probe-delta" }),
}).then((r) => r.json() as Promise<{ id: string }>);
console.log("session:", created.id);

const counts = new Map<string, number>();
const deltaSamples: string[] = [];
let running = true;

const sse = fetch(`${BASE}/event?directory=${encodeURIComponent(DIR)}`, {
  headers: { authorization: AUTH, accept: "text/event-stream" },
}).then(async (res) => {
  if (!res.ok || !res.body) throw new Error(`SSE -> ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (running) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (;;) {
      const idx = buf.indexOf("\n\n");
      if (idx === -1) break;
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = frame.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
      if (lines.length === 0) continue;
      let p: { type?: string };
      try { p = JSON.parse(lines.join("\n")); } catch { continue; }
      const t = p.type ?? "?";
      counts.set(t, (counts.get(t) ?? 0) + 1);
      if (t === "message.part.delta" && deltaSamples.length < 5) {
        deltaSamples.push(JSON.stringify(p).slice(0, 400));
      }
    }
  }
});

await Bun.sleep(2000);
await fetch(`${BASE}/session/${created.id}/prompt_async?directory=${encodeURIComponent(DIR)}`, {
  method: "POST",
  headers: { authorization: AUTH, "content-type": "application/json" },
  body: JSON.stringify({ parts: [{ type: "text", text: "Reply with exactly: pong" }], model: MODEL }),
});

const deadline = Date.now() + 60000;
while (Date.now() < deadline) {
  if (counts.get("session.idle")) break;
  await Bun.sleep(500);
}
running = false;
console.log("event counts:", JSON.stringify([...counts.entries()]));
console.log("message.part.delta samples:");
for (const s of deltaSamples) console.log("  " + s);
process.exit(0);
