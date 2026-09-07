import { Database } from "bun:sqlite";

const db = new Database("C:/Users/Admin/.local/share/opencode/opencode.db", { readonly: true });

const dirs = [
  "C:/Users/Admin/Downloads/VOXEL CRAFT",
  "C:/Users/Admin/Downloads",
  "C:/Users/Admin/Downloads/SoulHeart",
];

for (const dir of dirs) {
  const row = db
    .query<{ total: number; roots: number; children: number; archived: number; rootLive: number }, [string]>(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN parent_id IS NULL THEN 1 ELSE 0 END) as roots,
        SUM(CASE WHEN parent_id IS NOT NULL THEN 1 ELSE 0 END) as children,
        SUM(CASE WHEN time_archived IS NOT NULL THEN 1 ELSE 0 END) as archived,
        SUM(CASE WHEN parent_id IS NULL AND time_archived IS NULL THEN 1 ELSE 0 END) as rootLive
       FROM session WHERE directory = ?`
    )
    .get(dir);
  console.log(`${dir}`);
  console.log(`  total=${row.total} roots=${row.roots} children=${row.children} archived=${row.archived} rootLive=${row.rootLive}`);
}

// sample one session row's columns to see archived/parent shape
const sample = db
  .query<{ id: string; parent_id: string | null; time_archived: number | null }, [string]>(
    "SELECT id, parent_id, time_archived FROM session WHERE directory = ? LIMIT 3"
  )
  .all("C:/Users/Admin/Downloads/VOXEL CRAFT");
console.log("\nsamples:", JSON.stringify(sample, null, 2));
db.close();
