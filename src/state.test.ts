import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openState } from "./state";

let dbPath: string;
let store: ReturnType<typeof openState>;

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), "poc-state-")), "t.db");
  store = openState(dbPath);
});

describe("StateStore", () => {
  test("pairing round-trip", () => {
    expect(store.isPaired(100)).toBe(false);
    store.setPairing(100);
    expect(store.isPaired(100)).toBe(true);
  });

  test("active project per user", () => {
    expect(store.getActiveProject(1)).toBeUndefined();
    store.setActiveProject(1, "web");
    expect(store.getActiveProject(1)).toBe("web");
    store.setActiveProject(1, "api");
    expect(store.getActiveProject(1)).toBe("api");
  });

  test("session per user+project", () => {
    expect(store.getSession(1, "web")).toBeUndefined();
    store.setSession(1, "web", "sess-abc");
    store.setSession(1, "api", "sess-xyz");
    expect(store.getSession(1, "web")).toBe("sess-abc");
    expect(store.getSession(1, "api")).toBe("sess-xyz");
  });

  test("overrides set/get/clear", () => {
    expect(store.getOverride(1, "model")).toBeUndefined();
    store.setOverride(1, "model", "anthropic/claude-sonnet-4");
    expect(store.getOverride(1, "model")).toBe("anthropic/claude-sonnet-4");
    store.setOverride(1, "model", "openai/gpt-5");
    expect(store.getOverride(1, "model")).toBe("openai/gpt-5");
    store.clearOverride(1, "model");
    expect(store.getOverride(1, "model")).toBeUndefined();
  });

  test("persists across reopen", () => {
    store.setPairing(55);
    store.setActiveProject(55, "web");
    store.setSession(55, "web", "s1");
    store.setOverride(55, "agent", "build");
    store.close();
    const s2 = openState(dbPath);
    expect(s2.isPaired(55)).toBe(true);
    expect(s2.getActiveProject(55)).toBe("web");
    expect(s2.getSession(55, "web")).toBe("s1");
    expect(s2.getOverride(55, "agent")).toBe("build");
    s2.close();
  });

  test("dirs add/list deduped", () => {
    expect(store.listDirs()).toEqual([]);
    store.addDir("C:/code/web");
    store.addDir("C:/code/api");
    store.addDir("C:/code/web");
    const dirs = store.listDirs();
    expect(dirs).toContain("C:/code/web");
    expect(dirs).toContain("C:/code/api");
    expect(dirs.length).toBe(2);
  });

  test("dirs persist across reopen", () => {
    store.addDir("C:/code/web");
    store.close();
    const s2 = openState(dbPath);
    expect(s2.listDirs()).toEqual(["C:/code/web"]);
    s2.close();
  });
});
