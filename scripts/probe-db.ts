import { Database } from "bun:sqlite";

const dbPath = "C:/Users/Admin/.local/share/opencode/opencode.db";
const db = new Database(dbPath, { readonly: true });

const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log("TABLES:", tables.map((t) => t.name).join(", "));

for (const t of tables) {
  const cols = db.query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)").all(t.name);
  console.log(`\n[${t.name}]`, cols.map((c) => c.name).join(", "));
}
db.close();
