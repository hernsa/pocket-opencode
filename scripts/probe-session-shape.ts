const PORT = 4096;
const USER = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
const PASS = process.env.OPENCODE_SERVER_PASSWORD ?? "";
const AUTH = "Basic " + btoa(`${USER}:${PASS}`);

async function probe(directory: string): Promise<void> {
  const url = `http://127.0.0.1:${PORT}/session?directory=${encodeURIComponent(directory)}`;
  const res = await fetch(url, { headers: { authorization: AUTH } });
  if (!res.ok) {
    console.log(`${directory} -> HTTP ${res.status}`);
    return;
  }
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  console.log(`\n=== ${directory} -> ${rows.length} rows`);
  const first = rows[0] ?? {};
  console.log("first-row keys:", Object.keys(first).join(", "));
  const withParent = rows.filter((r) => r["parentID"] != null).length;
  const archived = rows.filter((r) => {
    const t = r["time"] as { archived?: number } | undefined;
    return t?.archived != null;
  }).length;
  console.log(`with parentID: ${withParent}, archived: ${archived}`);
  for (const r of rows.slice(0, 3)) {
    const t = r["time"] as { created?: number; archived?: number } | undefined;
    console.log(`- id=${String(r["id"]).slice(0, 12)} parentID=${String(r["parentID"])} title=${String(r["title"]).slice(0, 30)} archived=${t?.archived ?? "-"}`);
  }
}

await probe("C:/Users/Admin/Downloads/VOXEL CRAFT");
await probe("C:/Users/Admin/Downloads");
