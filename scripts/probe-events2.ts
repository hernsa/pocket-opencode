const PORT = 4096;
const USER = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
const PASS = process.env.OPENCODE_SERVER_PASSWORD ?? "";
const AUTH = "Basic " + btoa(`${USER}:${PASS}`);
const DIR = "C:/Users/Admin/Downloads";
const BASE = `http://127.0.0.1:${PORT}`;
const MODEL = { providerID: "opencode", modelID: "nemotron-3.5-lightning-free" };

async function json<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: AUTH, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

const created = await json<{ id: string }>("/session?directory=" + encodeURIComponent(DIR), "POST", { title: "probe-events2" });
const sid = created.id;
console.log("session:", sid);

const counts = new Map<string, number>();
const parts: Array<{ messageID: string; partId: string; type: string; textLen: number; snippet: string }> = [];
const msgUpdated: Array<{ role: string; id: string }> = [];
let running = true;

function handleFrame(frame: string): void {
  const dataLines = frame.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
  if (dataLines.length === 0) return;
  let parsed: { type?: string; properties?: Record<string, unknown> };
  try { parsed = JSON.parse(dataLines.join("\n")); } catch { return; }
  const t = parsed.type ?? "unknown";
  counts.set(t, (counts.get(t) ?? 0) + 1);
  if (t === "message.part.updated") {
    const props = parsed.properties ?? {};
    const part = (props.part ?? {}) as Record<string, unknown>;
    parts.push({
      messageID: String(part.messageID ?? "?"),
      partId: String(part.id ?? "?"),
      type: String(part.type ?? "?"),
      textLen: typeof part.text === "string" ? part.text.length : -1,
      snippet: JSON.stringify(parsed).slice(0, 500),
    });
  }
  if (t === "message.updated") {
    const info = (parsed.properties?.info ?? {}) as Record<string, unknown>;
    msgUpdated.push({ role: String(info.role ?? "?"), id: String(info.id ?? "?") });
  }
}

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
      handleFrame(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
  }
});

await Bun.sleep(2000);
const text = "what model are u?";
const pr = await fetch(`${BASE}/session/${sid}/prompt_async?directory=${encodeURIComponent(DIR)}`, {
  method: "POST",
  headers: { authorization: AUTH, "content-type": "application/json" },
  body: JSON.stringify({ parts: [{ type: "text", text }], model: MODEL }),
});
console.log("prompt_async ->", pr.status);

const deadline = Date.now() + 60000;
while (Date.now() < deadline) {
  if (counts.get("session.idle")) break;
  await Bun.sleep(500);
}
running = false;

console.log("\nevent counts:", JSON.stringify([...counts.entries()]));
console.log("\nmessage.updated (role@id):", msgUpdated.map((m) => `${m.role}@${m.id}`).join(", "));
console.log("\nmessage.part.updated captured:", parts.length);
for (const [i, p] of parts.entries()) {
  console.log(`[${i}] msg=${p.messageID} part=${p.partId} type=${p.type} textLen=${p.textLen}`);
  console.log(`     ${p.snippet}`);
}

interface Msg { info: { id: string; role: string }; parts: Array<{ id: string; type: string; text?: string }> }
const msgs = await json<Msg[]>(`/session/${sid}/message?directory=${encodeURIComponent(DIR)}`);
console.log("\nFINAL MESSAGES (role -> messageID -> parts):");
for (const m of msgs) {
  console.log(`${m.info.role} -> ${m.info.id}`);
  for (const p of m.parts ?? []) {
    console.log(`   part ${p.id} type=${p.type}${typeof p.text === "string" ? ` textLen=${p.text.length} text="${p.text.slice(0, 80)}"` : ""}`);
  }
}
process.exit(0);
