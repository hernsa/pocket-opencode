import { Database } from "bun:sqlite";

const db = new Database("pocket.db", { readonly: true });
const rows = db
  .query("SELECT user_id, project, session_id FROM session")
  .all() as Array<{ user_id: number; project: string; session_id: string }>;
console.log("sessions in db:", JSON.stringify(rows));

const user = process.env.OPENCODE_SERVER_USERNAME!;
const pass = process.env.OPENCODE_SERVER_PASSWORD!;
const auth = "Basic " + btoa(`${user}:${pass}`);

type AnyMsg = Record<string, any>;

for (const r of rows) {
  const res = await fetch(`http://127.0.0.1:4096/session/${r.session_id}/message`, {
    headers: { authorization: auth },
  });
  console.log(`\n=== session ${r.session_id} (project ${r.project}) -> HTTP ${res.status}`);
  if (!res.ok) continue;
  const msgs = (await res.json()) as AnyMsg[];
  for (const m of msgs) {
    const info = (m.info ?? m) as AnyMsg;
    const parts = (m.parts ?? []) as AnyMsg[];
    const texts = parts.filter((p) => p.type === "text").map((p) => (p.text ?? "").length);
    const summary = {
      id: info.id,
      role: info.role,
      finish: info.finish,
      model: info.modelID ? `${info.providerID}/${info.modelID}` : undefined,
      error: info.error
        ? { name: info.error.name, msg: info.error.data?.message ?? info.error.message }
        : undefined,
      tokens: info.tokens
        ? { in: info.tokens.input, out: info.tokens.output, reasoning: info.tokens.reasoning }
        : undefined,
      textLens: texts,
      partTypes: parts.map((p) => p.type),
    };
    console.log(JSON.stringify(summary));
    for (const p of parts) {
      if (p.type === "text" && p.text) {
        console.log(`  text[${(p.text as string).length}]: ${(p.text as string).slice(0, 200).replace(/\n/g, " ")}`);
      }
    }
  }
}
