import { Database } from "bun:sqlite";

export type OverrideKey = "model" | "agent" | "thinking" | "reasoning" | "workdir";

export interface StateStore {
  isPaired(chatId: number): boolean;
  setPairing(chatId: number): void;
  getActiveProject(userId: number): string | undefined;
  setActiveProject(userId: number, project: string): void;
  getSession(userId: number, project: string): string | undefined;
  setSession(userId: number, project: string, sessionId: string): void;
  getOverride(userId: number, key: OverrideKey): string | undefined;
  setOverride(userId: number, key: OverrideKey, value: string): void;
  clearOverride(userId: number, key: OverrideKey): void;
  addDir(path: string): void;
  listDirs(): string[];
  close(): void;
}

export function openState(dbPath: string): StateStore {
  const db = new Database(dbPath, { create: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS pairing (chat_id INTEGER PRIMARY KEY, paired_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS active_project (user_id INTEGER PRIMARY KEY, project TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS session (user_id INTEGER NOT NULL, project TEXT NOT NULL, session_id TEXT NOT NULL, PRIMARY KEY (user_id, project));
    CREATE TABLE IF NOT EXISTS overrides (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key));
    CREATE TABLE IF NOT EXISTS dirs (path TEXT PRIMARY KEY, added_at INTEGER NOT NULL);
  `);

  const qPair = db.query<{ chat_id: number }, [number]>("SELECT chat_id FROM pairing WHERE chat_id = ?");
  const iPair = db.prepare("INSERT OR REPLACE INTO pairing (chat_id, paired_at) VALUES (?, ?)");
  const qActive = db.query<{ project: string }, [number]>("SELECT project FROM active_project WHERE user_id = ?");
  const iActive = db.prepare("INSERT OR REPLACE INTO active_project (user_id, project) VALUES (?, ?)");
  const qSess = db.query<{ session_id: string }, [number, string]>("SELECT session_id FROM session WHERE user_id = ? AND project = ?");
  const iSess = db.prepare("INSERT OR REPLACE INTO session (user_id, project, session_id) VALUES (?, ?, ?)");
  const qOvr = db.query<{ value: string }, [number, string]>("SELECT value FROM overrides WHERE user_id = ? AND key = ?");
  const iOvr = db.prepare("INSERT OR REPLACE INTO overrides (user_id, key, value) VALUES (?, ?, ?)");
  const dOvr = db.prepare("DELETE FROM overrides WHERE user_id = ? AND key = ?");
  const iDir = db.prepare("INSERT OR IGNORE INTO dirs (path, added_at) VALUES (?, ?)");
  const qDirs = db.query<{ path: string }, []>("SELECT path FROM dirs ORDER BY added_at ASC");

  return {
    isPaired(chatId) {
      return qPair.get(chatId) != null;
    },
    setPairing(chatId) {
      iPair.run(chatId, Date.now());
    },
    getActiveProject(userId) {
      const row = qActive.get(userId);
      return row ? row.project : undefined;
    },
    setActiveProject(userId, project) {
      iActive.run(userId, project);
    },
    getSession(userId, project) {
      const row = qSess.get(userId, project);
      return row ? row.session_id : undefined;
    },
    setSession(userId, project, sessionId) {
      iSess.run(userId, project, sessionId);
    },
    getOverride(userId, key) {
      const row = qOvr.get(userId, key);
      return row ? row.value : undefined;
    },
    setOverride(userId, key, value) {
      iOvr.run(userId, key, value);
    },
    clearOverride(userId, key) {
      dOvr.run(userId, key);
    },
    addDir(path) {
      iDir.run(path, Date.now());
    },
    listDirs() {
      return qDirs.all().map((r) => r.path);
    },
    close() {
      db.close();
    },
  };
}
