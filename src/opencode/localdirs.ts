import { Database } from "bun:sqlite";

export interface DesktopDir {
  worktree: string;
  sessions?: number;
  name?: string;
}

export function readDesktopProjects(dbPath = "C:/Users/Admin/.local/share/opencode/opencode.db"): DesktopDir[] {
  try {
    const db = new Database(dbPath, { readonly: true });
    const dirs = new Map<string, DesktopDir>();
    try {
      const sess = db
        .query<{ directory: string; n: number }, []>(
          "SELECT directory, COUNT(*) AS n FROM session WHERE directory IS NOT NULL AND directory != '' GROUP BY directory ORDER BY n DESC"
        )
        .all();
      for (const r of sess) {
        const norm = r.directory.replace(/\\/g, "/");
        if (!norm || norm === "/") continue;
        const key = norm.toLowerCase();
        const existing = dirs.get(key);
        if (existing) {
          existing.sessions = (existing.sessions ?? 0) + r.n;
        } else {
          dirs.set(key, { worktree: norm, sessions: r.n });
        }
      }
      const proj = db
        .query<{ worktree: string; name: string | null }, []>(
          "SELECT worktree, name FROM project WHERE worktree IS NOT NULL AND worktree != ''"
        )
        .all();
      for (const r of proj) {
        const norm = r.worktree.replace(/\\/g, "/");
        if (!norm || norm === "/") continue;
        const key = norm.toLowerCase();
        if (!dirs.has(key)) dirs.set(key, { worktree: norm, name: r.name ?? undefined });
      }
    } finally {
      db.close();
    }
    return [...dirs.values()];
  } catch {
    return [];
  }
}
