import { Database } from "bun:sqlite";

const DB = "C:/Users/Admin/.local/share/opencode/opencode.db";
const db = new Database(DB, { readonly: true });

const TARGETS = ["voxel", "soulheart", "pocket", "downloads"];

console.log("=== sessions grouped by normalized directory (matches localdirs) ===");
const groups = db
  .query<{ directory: string; n: number }, []>(
    "SELECT directory, COUNT(*) AS n FROM session WHERE directory IS NOT NULL AND directory != '' GROUP BY directory ORDER BY n DESC"
  )
  .all();
const byNorm = new Map<string, { raw: string[]; total: number }>();
for (const g of groups) {
  const norm = g.directory.replace(/\\/g, "/").toLowerCase();
  const e = byNorm.get(norm) ?? { raw: [], total: 0 };
  e.raw.push(`${g.directory} (${g.n})`);
  e.total += g.n;
  byNorm.set(norm, e);
}
for (const t of TARGETS) {
  for (const [norm, info] of byNorm) {
    if (norm.includes(t)) {
      console.log(`${norm} -> TOTAL ${info.total}`);
      for (const r of info.raw) console.log("   ", r);
    }
  }
}

console.log("\n=== serve-style exact-dir counts for likely /project dirs ===");
const candidates = [
  "C:/Users/Admin/Downloads/VOXEL CRAFT",
  "C:/Users/Admin/Downloads/SoulHeart",
  "C:/Users/Admin/Downloads",
];
for (const c of candidates) {
  const exact = db
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM session WHERE directory = ?")
    .get(c);
  console.log(`${c} -> exact ${exact?.n ?? 0}`);
}

console.log("\n=== sample recent session rows (dir, title) ===");
const recent = db
  .query<{ directory: string; title: string | null }, []>(
    "SELECT directory, title FROM session ORDER BY time_created DESC LIMIT 12"
  )
  .all();
for (const r of recent) console.log(`${r.directory} | ${r.title ?? "(no title)"}`);
db.close();
