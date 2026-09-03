import { Database } from "bun:sqlite";

const PORT = 4096;
const USER = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
const PASS = process.env.OPENCODE_SERVER_PASSWORD ?? "";
const AUTH = "Basic " + btoa(`${USER}:${PASS}`);
const DIR = "C:/Users/Admin/Downloads";
const URL_BASE = `http://127.0.0.1:${PORT}`;

const db = new Database("pocket.db", { readonly: true });
const uid = 7575516389;
const proj = "downloads";
const oldSid = db
  .prepare("SELECT session_id FROM session WHERE user_id = ? AND project = ?")
  .get(uid, proj) as { session_id: string } | null;
console.log("existing session:", oldSid?.session_id ?? "none");
db.close();

async function json<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: { authorization: AUTH, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

const sid = await createSession();
const events: string[] = [];
const counts = new Map<string, number>();
const partInfos: Array<{ hasDelta: boolean; deltaLen: number; hasSessionID: boolean; snippet: string }> = [];

let running = true;

function parseSse(buf: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  for (;;) {
    const idx = buf.indexOf("\n\n");
    if (idx === -1) break;
    frames.push(buf.slice(0, idx));
    buf = buf.slice(idx + 2);
  }
  return { frames, rest: buf };
}

function handleFrame(frame: string): void {
  const dataLines = frame
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  if (dataLines.length === 0) return;
  let parsed: { type?: string; properties?: Record<string, unknown> };
  try {
    parsed = JSON.parse(dataLines.join("\n"));
  } catch {
    return;
  }
  const t = parsed.type ?? "unknown";
  counts.set(t, (counts.get(t) ?? 0) + 1);
  if (t === "message.part.updated" && events.length < 30) {
    const props = parsed.properties ?? {};
    const part = props.part as Record<string, unknown> | undefined;
    const delta = props.delta;
    const sidInPart = (part?.sessionID as string | undefined) ?? undefined;
    partInfos.push({
      hasDelta: typeof delta === "string",
      deltaLen: typeof delta === "string" ? delta.length : -1,
      hasSessionID: typeof sidInPart === "string",
      snippet: JSON.stringify(parsed).slice(0, 300),
    });
    events.push(t);
  }
}

async function createSession(): Promise<string> {
  const r = await json<{ id: string }>("/session?directory=" + encodeURIComponent(DIR), "POST", { title: "probe-events" });
  return r.id;
}

const sse = fetch(`${URL_BASE}/event?directory=${encodeURIComponent(DIR)}`, {
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
    const { frames, rest } = parseSse(buf);
    buf = rest;
    for (const f of frames) handleFrame(f);
  }
});

await Bun.sleep(2000);
const text = "Reply with exactly: pong";
const pr = await fetch(`${URL_BASE}/session/${sid}/prompt_async?directory=${encodeURIComponent(DIR)}`, {
  method: "POST",
  headers: { authorization: AUTH, "content-type": "application/json" },
  body: JSON.stringify({ parts: [{ type: "text", text }] }),
});
console.log("prompt_async ->", pr.status);

const deadline = Date.now() + 45000;
while (Date.now() < deadline) {
  if (counts.get("session.idle")) break;
  await Bun.sleep(500);
}
running = false;

console.log("session:", sid);
console.log("event counts:", JSON.stringify([...counts.entries()]));
console.log("message.part.updated captured:", partInfos.length);
for (const [i, p] of partInfos.entries()) {
  console.log(`[${i}] delta=${p.hasDelta ? p.deltaLen : "MISSING"} sessionID=${p.hasSessionID ? "yes" : "NO"} :: ${p.snippet}`);
}
process.exit(0);
