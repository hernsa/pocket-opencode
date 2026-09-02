import { createOpencodeClient } from "@opencode-ai/sdk";

export interface PromptOpts {
  directory?: string;
  model?: { providerID: string; modelID: string };
  agent?: string;
}

export interface OcClientOpts {
  port: number;
  spawner?: (cmdline: string[]) => void;
  auth?: { username: string; password: string };
}

export function opencodeAuthHeaders(
  env: Record<string, string | undefined> = process.env
): Record<string, string> {
  const user = env["OPENCODE_SERVER_USERNAME"];
  const pass = env["OPENCODE_SERVER_PASSWORD"];
  if (!user || !pass) return {};
  return { Authorization: `Basic ${btoa(`${user}:${pass}`)}` };
}

function unwrap<T>(r: unknown): T {
  const w = r as { data?: unknown; response?: { ok?: boolean; status?: number } };
  if (w && typeof w === "object" && w.response && typeof w.response.ok === "boolean" && !w.response.ok) {
    throw new Error(`opencode api error: HTTP ${w.response.status}`);
  }
  return (w && typeof w === "object" && "data" in w && w.data !== undefined ? w.data : r) as T;
}

function defaultSpawner(cmdline: string[]): void {
  Bun.spawn(cmdline, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
}

export class OpencodeClient {
  private readonly port: number;
  private readonly client: ReturnType<typeof createOpencodeClient>;
  private readonly spawner: (cmdline: string[]) => void;

  constructor(opts: OcClientOpts) {
    this.port = opts.port;
    const headers = opencodeAuthHeaders(
      opts.auth
        ? { OPENCODE_SERVER_USERNAME: opts.auth.username, OPENCODE_SERVER_PASSWORD: opts.auth.password }
        : process.env
    );
    const cfg: Parameters<typeof createOpencodeClient>[0] = { baseUrl: `http://127.0.0.1:${opts.port}` };
    if (Object.keys(headers).length > 0) {
      cfg.fetch = (request: Request) => {
        const req = new Request(request);
        for (const [k, v] of Object.entries(headers)) req.headers.set(k, v);
        return fetch(req);
      };
    }
    this.client = createOpencodeClient(cfg);
    this.spawner = opts.spawner ?? defaultSpawner;
  }

  async health(): Promise<boolean> {
    try {
      const r = (await this.client.project.current()) as { response?: { ok?: boolean } };
      if (r && typeof r === "object" && r.response && typeof r.response.ok === "boolean") {
        return r.response.ok;
      }
      return false;
    } catch {
      return false;
    }
  }

  async ensureRunning(timeoutMs = 20000): Promise<void> {
    if (await this.health()) return;
    this.spawner([
      "cmd", "/c", "opencode", "serve",
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
    const res = unwrap<{ id: string }>(
      await this.client.session.create({ query: { directory }, body: { title } })
    );
    return res.id;
  }

  async prompt(sessionId: string, text: string, opts?: PromptOpts): Promise<void> {
    await this.client.session.promptAsync({
      path: { id: sessionId },
      query: opts?.directory ? { directory: opts.directory } : undefined,
      body: {
        parts: [{ type: "text", text }],
        model: opts?.model,
        agent: opts?.agent,
      },
    });
  }

  async abort(sessionId: string): Promise<void> {
    await this.client.session.abort({ path: { id: sessionId } });
  }

  async undo(sessionId: string): Promise<void> {
    await this.client.session.revert({ path: { id: sessionId } });
  }

  async getDiff(sessionId: string): Promise<Array<{ file: string; additions: number; deletions: number }>> {
    const rows = unwrap<Array<{ file: string; additions?: number; deletions?: number }>>(
      await this.client.session.diff({ path: { id: sessionId } })
    );
    return rows.map((r) => ({ file: r.file, additions: r.additions ?? 0, deletions: r.deletions ?? 0 }));
  }

  async listModels(): Promise<Array<{ providerID: string; modelID: string }>> {
    const raw = unwrap<unknown>(await this.client.provider.list());
    const out: Array<{ providerID: string; modelID: string }> = [];
    if (Array.isArray(raw)) {
      for (const p of raw as Array<{ id?: string; models?: Record<string, unknown> }>) {
        if (!p.id) continue;
        for (const mid of Object.keys(p.models ?? {})) out.push({ providerID: p.id, modelID: mid });
      }
    } else if (raw && typeof raw === "object") {
      const rec = raw as Record<string, { models?: Record<string, unknown> }>;
      for (const [pid, p] of Object.entries(rec)) {
        for (const mid of Object.keys(p?.models ?? {})) out.push({ providerID: pid, modelID: mid });
      }
    }
    return out;
  }

  async listAgents(): Promise<string[]> {
    const raw = unwrap<unknown>(await this.client.app.agents());
    if (!Array.isArray(raw)) return [];
    return raw
      .map((a) => (typeof a === "string" ? a : (a as { name?: string }).name))
      .filter((n): n is string => typeof n === "string" && n.length > 0);
  }

  async replyPermission(sessionId: string, permissionId: string, response: "once" | "always" | "reject"): Promise<void> {
    await this.client.postSessionIdPermissionsPermissionId({
      path: { id: sessionId, permissionID: permissionId },
      body: { response },
    });
  }
}
