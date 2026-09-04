import { Database } from "bun:sqlite";

const dbPath = "C:/Users/Admin/.local/share/opencode/opencode.db";
const db = new Database(dbPath, { readonly: true });

const rows = db
  .query<{ id: string; worktree: string; name: string | null; icon_color: string | null; time_updated: number }, []>(
    "SELECT id, worktree, name, icon_color, time_updated FROM project WHERE worktree IS NOT NULL AND worktree != '' ORDER BY time_updated DESC"
  )
  .all();

console.log("COUNT:", rows.length);
for (const r of rows) {
  console.log(`${r.icon_color ?? "-"} | ${r.name ?? "(no name)"} | ${r.worktree} | ${new Date(r.time_updated).toISOString()}`);
}
db.close();
