import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, ConfigError } from "./config";

function writeCfg(json: string): string {
  const dir = mkdtempSync(join(tmpdir(), "poc-cfg-"));
  const p = join(dir, "config.json");
  writeFileSync(p, json);
  return p;
}

describe("loadConfig", () => {
  test("parses full config", () => {
    const path = writeCfg(
      `{"telegram_token":"123:ABC","opencode_port":4096,"db_path":"state.db","allow":[111,222],"projects":[{"name":"web","path":"C:/code/web"},{"name":"api","path":"C:/code/api"}]}`
    );
    const cfg = loadConfig(path);
    expect(cfg.telegramToken).toBe("123:ABC");
    expect(cfg.opencodePort).toBe(4096);
    expect(cfg.dbPath).toBe("state.db");
    expect(cfg.projects).toEqual([
      { name: "web", path: "C:/code/web" },
      { name: "api", path: "C:/code/api" },
    ]);
    expect(cfg.allowedUserIds).toEqual([111, 222]);
  });

  test("applies defaults", () => {
    const path = writeCfg(
      `{"telegram_token":"123:ABC","allow":[7],"projects":[{"name":"x","path":"C:/x"}]}`
    );
    const cfg = loadConfig(path);
    expect(cfg.opencodePort).toBe(4096);
    expect(cfg.dbPath).toBe("pocket.db");
  });

  test("rejects missing token", () => {
    const path = writeCfg(`{"allow":[7],"projects":[{"name":"x","path":"C:/x"}]}`);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  test("rejects empty allowlist", () => {
    const path = writeCfg(`{"telegram_token":"t","allow":[],"projects":[{"name":"x","path":"C:/x"}]}`);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  test("rejects zero projects", () => {
    const path = writeCfg(`{"telegram_token":"t","allow":[7],"projects":[]}`);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  test("rejects malformed json", () => {
    const path = writeCfg(`{ not json`);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  test("rejects missing file", () => {
    expect(() => loadConfig("Z:/definitely/not/here.json")).toThrow(ConfigError);
  });
});
