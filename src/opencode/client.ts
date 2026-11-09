export interface PromptOpts {
  directory?: string;
  model?: { providerID: string; modelID: string };
  agent?: string;
  system?: string;
}

export interface OcClientOpts {
  port: number;
  spawner?: (cmdline: string[]) => void;
  auth?: { username: string; password: string };
  findPortOwner?: (port: number) => { pid: number; image: string } | null;
  killPid?: (pid: number) => void;
  serveBinary?: string[];
}

export function opencodeAuthHeaders(
  env: Record<string, string | undefined> = process.env
): Record<string, string> {
  // V2 uses a single password (OPENCODE_PASSWORD) instead of V1's
  // OPENCODE_SERVER_USERNAME / OPENCODE_SERVER_PASSWORD pair.
  const pass = env["OPENCODE_PASSWORD"];
  if (!pass) return {};
  return { Authorization: `Basic ${btoa(`opencode:${pass}`)}` };
}

function defaultSpawner(cmdline: string[]): void {
  Bun.spawn(cmdline, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
}

function defaultFindPortOwner(port: number): { pid: number; image: string } | null {
  try {
    const proc = Bun.spawnSync(["cmd", "/c", "netstat", "-ano", "-p", "TCP"]);
    const out = proc.stdout.toString();
    let pid: number | null = null;
    for (const line of out.split("\n")) {
      const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+\S+\s+(\d+)\s*$/i);
      if (!m) continue;
      if (Number(m[2]) !== port) continue;
      pid = Number(m[3]);
      break;
    }
    if (!pid) return null;
    const tl = Bun.spawnSync(["cmd", "/c", `tasklist /FI "PID eq ${pid}" /FO CSV /NH`]);
    const im = tl.stdout.toString().trim().match(/^"([^"]+)"/);
    return { pid, image: im ? im[1] : "unknown" };
  } catch {
    return null;
  }
}

function defaultKillPid(pid: number): void {
  process.kill(pid);
}

function defaultServeBinary(): string[] {
  const desktopCli =
    "C:/Users/Admin/AppData/Roaming/ai.opencode.desktop/cli/2.2.1-x64/opencode-cli.exe";
  try {
    const p = Bun.spawnSync(["cmd", "/c", "where opencode >nul 2>&1"]);
    if (p.exitCode === 0) {
      return ["cmd", "/c", "opencode", "serve"];
    }
  } catch {
    // fall through to desktop CLI
  }
  return ["cmd", "/c", desktopCli, "serve"];
}

// Minimal V2 API response types (raw fetch, no SDK dependency)
interface V2ServerInfo {
  version?: string;
  status?: string;
}

interface V2SessionSummary {
  id: string;
  title?: string;
}

interface V2CreateSessionResponse {
  id: string;
}

interface V2ModelEntry {
  id: string;
  provider_id?: string;
}

interface V2ModelList {
  models: V2ModelEntry[];
}

interface V2AgentEntry {
  id: string;
  name?: string;
}

interface V2AgentList {
  agents: V2AgentEntry[];
}

interface V2PromptPart {
  type: string;
  text: string;
}

interface V2PromptRequest {
  parts: V2PromptPart[];
  model?: unknown;
  agent?: string;
  system?: string;
}

export class OpencodeClient {
  private readonly port: number;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly spawner: (cmdline: string[]) => void;
  private readonly findPortOwner: (port: number) => { pid: number; image: string } | null;
  private readonly killPid: (pid: number) => void;
  private readonly serveBinary: string[];

  constructor(opts: OcClientOpts) {
    this.port = opts.port;
    this.baseUrl = `http://127.0.0.1:${opts.port}`;
    this.headers = opencodeAuthHeaders(
      opts.auth
        ? { OPENCODE_PASSWORD: opts.auth.password }
        : process.env
    );
    this.spawner = opts.spawner ?? defaultSpawner;
    this.findPortOwner = opts.findPortOwner ?? defaultFindPortOwner;
    this.killPid = opts.killPid ?? defaultKillPid;
    this.serveBinary = opts.serveBinary ?? defaultServeBinary();
  }

  private apiHeaders(): Record<string, string> {
    return { ...this.headers, Accept: "application/json" };
  }

  private async fetchJson(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.apiHeaders(), ...(init?.headers ?? {}) },
    });
    return res;
  }

  private async healthState(): Promise<"ok" | "auth" | "down"> {
    try {
      const res = await this.fetchJson("/api/info");
      if (res.ok) return "ok";
      if (res.status === 401) return "auth";
      return "down";
    } catch {
      return "down";
    }
  }

  async health(): Promise<boolean> {
    return (await this.healthState()) === "ok";
  }

  async ensureRunning(timeoutMs = 120000): Promise<void> {
    const state = await this.healthState();
    if (state === "ok") return;
    if (state === "auth") {
      const owner = this.findPortOwner(this.port);
      if (!owner) {
        throw new Error(`opencode serve on port ${this.port} rejects our credentials and no process was found holding the port — free the port and retry`);
      }
      if (!/opencode/i.test(owner.image)) {
        throw new Error(`port ${this.port} is held by ${owner.image} (pid ${owner.pid}), not opencode — refusing to kill it. Free the port and retry`);
      }
      this.killPid(owner.pid);
    }
    const base = this.serveBinary ?? defaultServeBinary();
    this.spawner([
      ...base,
      `--port`, String(this.port),
      "--hostname", "127.0.0.1",
      "--log-level", "WARN",
    ]);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await Bun.sleep(500);
      if (await this.health()) return;
    }
    throw new Error(`opencode serve did not come up on port ${this.port} within ${timeoutMs}ms`);
  }

  async createSession(directory: string, title?: string): Promise<string> {
    const body: Record<string, unknown> = {};
    if (title) body.title = title;
    if (directory) body.directory = directory;
    const res = await this.fetchJson("/api/session", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`create session: HTTP ${res.status}`);
    const parsed: V2CreateSessionResponse = await res.json();
    return parsed.id;
  }

  async prompt(sessionId: string, text: string, opts?: PromptOpts): Promise<void> {
    const body: V2PromptRequest = {
      parts: [{ type: "text", text }],
    };
    if (opts?.model) body.model = opts.model;
    if (opts?.agent) body.agent = opts.agent;
    if (opts?.system) body.system = opts.system;
    const res = await this.fetchJson(`/api/session/${sessionId}/prompt`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`prompt: HTTP ${res.status}`);
    // V2 prompt returns { info, parts } — we don't need to consume the body here;
    // streaming events are consumed via subscribeEvents.
  }

  async abort(sessionId: string): Promise<void> {
    const res = await this.fetchJson(`/api/session/${sessionId}/interrupt`, {
      method: "POST",
    });
    if (!res.ok) throw new Error(`abort: HTTP ${res.status}`);
  }

  async undo(sessionId: string): Promise<void> {
    const res = await this.fetchJson(`/api/session/${sessionId}/revert/commit`, {
      method: "POST",
    });
    if (!res.ok) throw new Error(`undo: HTTP ${res.status}`);
  }

  async getDiff(sessionId: string): Promise<Array<{ file: string; additions: number; deletions: number }>> {
    const res = await this.fetchJson(`/api/session/${sessionId}/diff`);
    if (!res.ok) throw new Error(`diff: HTTP ${res.status}`);
    const rows: Array<{ file: string; additions?: number; deletions?: number }> = await res.json();
    return rows.map((r) => ({ file: r.file, additions: r.additions ?? 0, deletions: r.deletions ?? 0 }));
  }

  async listModels(): Promise<Array<{ providerID: string; modelID: string }>> {
    const res = await this.fetchJson("/api/model");
    if (!res.ok) throw new Error(`list models: HTTP ${res.status}`);
    const parsed: V2ModelList = await res.json();
    return parsed.models.map((m) => ({ providerID: m.provider_id ?? "opencode", modelID: m.id }));
  }

  async listAgents(): Promise<string[]> {
    const res = await this.fetchJson("/api/agent");
    if (!res.ok) throw new Error(`list agents: HTTP ${res.status}`);
    const parsed: V2AgentList = await res.json();
    return parsed.agents
      .map((a) => a.name ?? a.id)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
  }

  async listSessions(directory?: string): Promise<Array<{ id: string; title: string }>> {
    const dirs = directory ? [directory] : [];
    if (directory && /[\\/]/.test(directory)) {
      const alt = directory.includes("\\")
        ? directory.replace(/\\/g, "/")
        : directory.replace(/\//g, "\\");
      if (alt !== directory) dirs.push(alt);
    }
    const out = new Map<string, { id: string; title: string }>();
    const queryDirs = dirs.length > 0 ? dirs : [undefined];
    for (const d of queryDirs) {
      const url = d !== undefined ? `/api/session?directory=${encodeURIComponent(d)}` : "/api/session";
      const res = await this.fetchJson(url);
      if (!res.ok) continue;
      const rows: V2SessionSummary[] = await res.json();
      for (const r of rows) {
        if (typeof r.id !== "string" || r.id.length === 0 || out.has(r.id)) continue;
        if ((r as any).archived != null || (r as any).parent_id != null) continue;
        out.set(r.id, { id: r.id, title: r.title ?? r.id });
      }
    }
    return [...out.values()];
  }

  async listProjects(): Promise<Array<{ id: string; worktree: string }>> {
    // V2 may not expose /api/project; fall back to sessions with directory info
    const res = await this.fetchJson("/api/project");
    if (!res.ok) return [];
    const rows: Array<{ id?: string; worktree?: string }> = await res.json();
    return rows
      .map((r) => r as { id?: string; worktree?: string })
      .filter((r): r is { id: string; worktree: string } => typeof r.id === "string" && typeof r.worktree === "string" && r.worktree.length > 0);
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const res = await this.fetchJson(`/api/session/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    });
    if (!res.ok) throw new Error(`rename: HTTP ${res.status}`);
  }

  async replyPermission(sessionId: string, permissionId: string, response: "once" | "always" | "reject"): Promise<void> {
    const res = await this.fetchJson(`/api/session/${sessionId}/permission/${permissionId}`, {
      method: "POST",
      body: JSON.stringify({ response }),
    });
    if (!res.ok) throw new Error(`reply permission: HTTP ${res.status}`);
  }
}
