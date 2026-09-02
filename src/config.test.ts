import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, ConfigError } from "./config";

function writeCfg(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "poc-cfg-"));
  const p = join(dir, "config.toml");
  writeFileSync(p, toml);
  return p;
}

describe("loadConfig", () => {
  test("parses full config", () => {
    const path = writeCfg(
      `telegram_token = "123:ABC"\nopencode_port = 4096\ndb_path = "state.db"\n\n[[projects]]\nname = "web"\npath = "C:/code/web"\n\n[[projects]]\nname = "api"\npath = "C:/code/api"\n\n[[allow]]\nid = 111\n\n[[allow]]\nid = 222\n`
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
      `telegram_token = "123:ABC"\n[[allow]]\nid = 7\n[[projects]]\nname = "x"\npath = "C:/x"\n`
    );
    const cfg = loadConfig(path);
    expect(cfg.opencodePort).toBe(4096);
    expect(cfg.dbPath).toBe("pocket.db");
  });

  test("rejects missing token", () => {
    const path = writeCfg(`[[allow]]\nid = 7\n[[projects]]\nname = "x"\npath = "C:/x"\n`);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  test("rejects empty allowlist", () => {
    const path = writeCfg(`telegram_token = "t"\n[[projects]]\nname = "x"\npath = "C:/x"\n`);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  test("rejects zero projects", () => {
    const path = writeCfg(`telegram_token = "t"\n[[allow]]\nid = 7\n`);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  test("rejects malformed toml", () => {
    const path = writeCfg(`this is not = toml ===\n`);
    expect(() => loadConfig(path)).toThrow(ConfigError);
  });

  test("rejects missing file", () => {
    expect(() => loadConfig("Z:/definitely/not/here.toml")).toThrow(ConfigError);
  });
});
