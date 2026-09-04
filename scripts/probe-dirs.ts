import { Database } from "bun:sqlite";

const DB = "C:/Users/Admin/.local/share/opencode/opencode.db";
const db = new Database(DB, { readonly: true });

console.log("=== project_directory (directory, type, strategy, count) ===");
try {
  const rows = db
    .query<{ directory: string; type: string; strategy: string; n: number }, []>(
      `SELECT directory, type, strategy, COUNT(*) as n FROM project_directory GROUP BY directory, type, strategy ORDER BY MAX(time_created) DESC`
    )
    .all();
  for (const r of rows) console.log(`${r.directory} | type=${r.type} | strategy=${r.strategy} | n=${r.n}`);
} catch (e) {
  console.log("project_directory error:", (e as Error).message);
}

console.log("\n=== workspace (directory, name, type) ===");
try {
  const rows = db
    .query<{ directory: string; name: string | null; type: string }, []>(
      `SELECT directory, name, type FROM workspace ORDER BY time_used DESC`
    )
    .all();
  for (const r of rows) console.log(`${r.directory} | name=${r.name} | type=${r.type}`);
} catch (e) {
  console.log("workspace error:", (e as Error).message);
}

console.log("\n=== session.directory DISTINCT ===");
try {
  const rows = db
    .query<{ directory: string; n: number }, []>(
      `SELECT directory, COUNT(*) as n FROM session GROUP BY directory ORDER BY MAX(time_created) DESC LIMIT 40`
    )
    .all();
  for (const r of rows) console.log(`${r.directory} | n=${r.n}`);
} catch (e) {
  console.log("session error:", (e as Error).message);
}

db.close();
