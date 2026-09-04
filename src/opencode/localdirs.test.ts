import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { readDesktopProjects } from "./localdirs";

let dbPath: string;

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), "poc-ldirs-")), "opencode.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT);
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT, name TEXT);
  `);
  db.prepare("INSERT INTO session (id, directory) VALUES (?, ?)").run("s1", "C:\\Users\\Admin\\Downloads\\VOXEL CRAFT");
  db.prepare("INSERT INTO session (id, directory) VALUES (?, ?)").run("s2", "C:/Users/Admin/Downloads/VOXEL CRAFT");
  db.prepare("INSERT INTO session (id, directory) VALUES (?, ?)").run("s3", "C:/Users/Admin/Videos/velo");
  db.prepare("INSERT INTO session (id, directory) VALUES (?, ?)").run("s4", "/");
  db.prepare("INSERT INTO session (id, directory) VALUES (?, ?)").run("s5", "");
  db.prepare("INSERT INTO project (id, worktree, name) VALUES (?, ?, ?)").run("p1", "C:\\Users\\Admin\\Downloads\\SoulHeart", "SoulHeart");
  db.prepare("INSERT INTO project (id, worktree, name) VALUES (?, ?, ?)").run("p2", "/", null);
  db.close();
});

describe("readDesktopProjects", () => {
  test("extracts session directories and project worktrees, normalized + deduped", () => {
    const dirs = readDesktopProjects(dbPath);
    const norm = dirs.map((d) => d.worktree);
    expect(norm).toContain("C:/Users/Admin/Downloads/VOXEL CRAFT");
    expect(norm).toContain("C:/Users/Admin/Videos/velo");
    expect(norm).toContain("C:/Users/Admin/Downloads/SoulHeart");
    expect(norm.filter((d) => d.toLowerCase() === "c:/users/admin/downloads/voxel craft").length).toBe(1);
    expect(norm).not.toContain("/");
  });

  test("returns [] for nonexistent db", () => {
    expect(readDesktopProjects("Z:/nope/missing.db")).toEqual([]);
  });

  test("returns [] when tables are missing", () => {
    const empty = join(mkdtempSync(join(tmpdir(), "poc-ldirs-empty-")), "e.db");
    const db = new Database(empty);
    db.exec("CREATE TABLE other (x TEXT)");
    db.close();
    expect(readDesktopProjects(empty)).toEqual([]);
  });
});
