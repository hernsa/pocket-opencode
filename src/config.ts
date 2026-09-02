import { readFileSync, existsSync } from "node:fs";

export class ConfigError extends Error {}

export interface Project {
  name: string;
  path: string;
}

export interface AppConfig {
  telegramToken: string;
  allowedUserIds: number[];
  opencodePort: number;
  dbPath: string;
  projects: Project[];
}

export function loadConfig(path: string): AppConfig {
  if (!existsSync(path)) throw new ConfigError(`config not found: ${path}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`invalid JSON in ${path}: ${(e as Error).message}`);
  }
  const t = (raw ?? {}) as Record<string, unknown>;

  const token = t["telegram_token"];
  if (typeof token !== "string" || token.length === 0) {
    throw new ConfigError("telegram_token is required");
  }

  const allow = t["allow"];
  const allowedUserIds = Array.isArray(allow)
    ? allow.filter((id): id is number => typeof id === "number")
    : [];
  if (allowedUserIds.length === 0) {
    throw new ConfigError(`"allow" must be an array of your Telegram user IDs, e.g. "allow": [123456789]`);
  }

  const projectsRaw = Array.isArray(t["projects"]) ? t["projects"] : [];
  const projects: Project[] = projectsRaw.map((p) => {
    const e = p as Record<string, unknown>;
    if (typeof e["name"] !== "string" || typeof e["path"] !== "string") {
      throw new ConfigError(`each entry in "projects" needs "name" and "path"`);
    }
    return { name: e["name"], path: e["path"] };
  });
  if (projects.length === 0) {
    throw new ConfigError(`at least one entry in "projects" is required`);
  }

  return {
    telegramToken: token,
    allowedUserIds,
    opencodePort: typeof t["opencode_port"] === "number" ? t["opencode_port"] : 4096,
    dbPath: typeof t["db_path"] === "string" ? t["db_path"] : "pocket.db",
    projects,
  };
}
