import { describe, test, expect, afterAll, beforeEach, afterEach } from "bun:test";
import { OpencodeClient, opencodeAuthHeaders } from "./client";

const seen: Array<{ method: string; path: string; body: unknown }> = [];

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    let body: unknown = undefined;
    try { body = await req.json(); } catch {}
    seen.push({ method: req.method, path: url.pathname, body });
    if (url.pathname === "/project/current") return Response.json({ id: "p1" });
    if (url.pathname === "/session" && req.method === "POST") return Response.json({ id: "sess-1" });
    if (url.pathname === "/session/sess-1/prompt_async") return new Response(null, { status: 204 });
    if (url.pathname === "/session/sess-1/abort") return Response.json({ ok: true });
    if (url.pathname === "/session/sess-1/revert") return Response.json({ ok: true });
    if (url.pathname === "/session/sess-1/diff")
      return Response.json([
        { file: "src/a.ts", before: "", after: "", additions: 12, deletions: 3 },
        { file: "src/b.ts", before: "", after: "", additions: 0, deletions: 7 },
      ]);
    if (url.pathname === "/config/providers")
      return Response.json({
        providers: [
          { id: "opencode", models: { "nemotron-3-ultra-free": {}, "big-pickle": {} } },
          { id: "chatbai", models: { "glm-5.3-flash": {} } },
        ],
      });
    if (url.pathname === "/provider")
      return Response.json({
        all: [
          { id: "anthropic", models: { "claude-sonnet-4": {}, "claude-opus-4": {} } },
          { id: "openai", models: { "gpt-5": {} } },
        ],
      });
    if (url.pathname === "/agent") return Response.json([{ name: "build" }, { name: "plan" }]);
    if (url.pathname.startsWith("/session/sess-1/permissions/")) return Response.json({ ok: true });
    return new Response("not found", { status: 404 });
  },
});

afterAll(() => server.stop(true));

function makeClient(spawner?: (cmdline: string[]) => void) {
  return new OpencodeClient({ port: server.port!, spawner });
}

const authSeen: Array<{ auth: string | null; path: string }> = [];
const authServer = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const expected = "Basic " + btoa("opencode:7249abc4-ddfc-4a29-a474-b68bb65ccdcf");
    authSeen.push({ auth: req.headers.get("authorization"), path: url.pathname });
    const ok = req.headers.get("authorization") === expected;
    if (!ok) return new Response("unauthorized", { status: 401, headers: { "www-authenticate": 'Basic realm="Secure Area"' } });
    if (url.pathname === "/project/current") return Response.json({ id: "p1" });
    if (url.pathname === "/session" && req.method === "POST") return Response.json({ id: "sess-auth" });
    return new Response("nf", { status: 404 });
  },
});

afterAll(() => authServer.stop(true));

const AUTH_ENV = {
  OPENCODE_SERVER_USERNAME: "opencode",
  OPENCODE_SERVER_PASSWORD: "7249abc4-ddfc-4a29-a474-b68bb65ccdcf",
};

const savedAuth: Record<string, string | undefined> = {};

beforeEach(() => {
  savedAuth.u = process.env.OPENCODE_SERVER_USERNAME;
  savedAuth.p = process.env.OPENCODE_SERVER_PASSWORD;
  delete process.env.OPENCODE_SERVER_USERNAME;
  delete process.env.OPENCODE_SERVER_PASSWORD;
});

afterEach(() => {
  if (savedAuth.u !== undefined) process.env.OPENCODE_SERVER_USERNAME = savedAuth.u;
  if (savedAuth.p !== undefined) process.env.OPENCODE_SERVER_PASSWORD = savedAuth.p;
});

describe("opencode auth", () => {
  test("opencodeAuthHeaders empty without env", () => {
    expect(opencodeAuthHeaders()).toEqual({});
  });

  test("opencodeAuthHeaders builds Basic header from env", () => {
    process.env.OPENCODE_SERVER_USERNAME = "opencode";
    process.env.OPENCODE_SERVER_PASSWORD = "7249abc4-ddfc-4a29-a474-b68bb65ccdcf";
    const h = opencodeAuthHeaders();
    expect(h["Authorization"]).toBe("Basic " + btoa("opencode:7249abc4-ddfc-4a29-a474-b68bb65ccdcf"));
  });

  test("client sends Basic auth header on requests", async () => {
    process.env.OPENCODE_SERVER_USERNAME = AUTH_ENV.OPENCODE_SERVER_USERNAME;
    process.env.OPENCODE_SERVER_PASSWORD = AUTH_ENV.OPENCODE_SERVER_PASSWORD;
    const c = new OpencodeClient({ port: authServer.port! });
    expect(await c.health()).toBe(true);
    expect(await c.createSession("C:/x")).toBe("sess-auth");
    expect(authSeen.every((s) => s.auth === "Basic " + btoa("opencode:7249abc4-ddfc-4a29-a474-b68bb65ccdcf"))).toBe(true);
  });

  test("health returns false on 401", async () => {
    const c = new OpencodeClient({ port: authServer.port! });
    expect(await c.health()).toBe(false);
  });

  test("createSession rejects on 401 instead of returning undefined id", async () => {
    const c = new OpencodeClient({ port: authServer.port! });
    await expect(c.createSession("C:/x")).rejects.toThrow(/401|Unauthorized|unauthorized/i);
  });
});

describe("OpencodeClient", () => {
  test("health returns true when server responds", async () => {
    expect(await makeClient().health()).toBe(true);
  });

  test("health returns false on dead port", async () => {
    expect(await new OpencodeClient({ port: 1 }).health()).toBe(false);
  });

  test("ensureRunning does not spawn when healthy", async () => {
    let spawned = 0;
    await makeClient(() => { spawned++; }).ensureRunning(2000);
    expect(spawned).toBe(0);
  });

  test("ensureRunning throws after timeout on dead port", async () => {
    let spawned = 0;
    const dead = new OpencodeClient({ port: 1, spawner: () => { spawned++; } });
    await expect(dead.ensureRunning(300)).rejects.toThrow(/did not come up/);
    expect(spawned).toBe(1);
  });

  test("createSession returns id", async () => {
    const id = await makeClient().createSession("C:/code/web", "hello");
    expect(id).toBe("sess-1");
  });

  test("prompt posts text part + model + agent to prompt_async", async () => {
    await makeClient().prompt("sess-1", "do the thing", {
      directory: "C:/code/web",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
      agent: "build",
    });
    const call = seen.find((c) => c.path === "/session/sess-1/prompt_async");
    expect(call).toBeDefined();
    const b = call!.body as { parts: Array<{ type: string; text: string }>; model?: unknown; agent?: string };
    expect(b.parts[0].type).toBe("text");
    expect(b.parts[0].text).toBe("do the thing");
    expect(b.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4" });
    expect(b.agent).toBe("build");
  });

  test("abort and undo hit their endpoints", async () => {
    const c = makeClient();
    await c.abort("sess-1");
    await c.undo("sess-1");
    expect(seen.some((x) => x.path === "/session/sess-1/abort")).toBe(true);
    expect(seen.some((x) => x.path === "/session/sess-1/revert")).toBe(true);
  });

  test("getDiff maps additions/deletions", async () => {
    const d = await makeClient().getDiff("sess-1");
    expect(d).toEqual([
      { file: "src/a.ts", additions: 12, deletions: 3 },
      { file: "src/b.ts", additions: 0, deletions: 7 },
    ]);
  });

  test("listModels normalizes provider record into pairs", async () => {
    const m = await makeClient().listModels();
    expect(m).toEqual([
      { providerID: "opencode", modelID: "nemotron-3-ultra-free" },
      { providerID: "opencode", modelID: "big-pickle" },
      { providerID: "chatbai", modelID: "glm-5.3-flash" },
    ]);
  });

  test("listAgents normalizes objects into names", async () => {
    expect(await makeClient().listAgents()).toEqual(["build", "plan"]);
  });

  test("replyPermission posts response to permission endpoint", async () => {
    await makeClient().replyPermission("sess-1", "perm-9", "once");
    const call = seen.find((c) => c.path === "/session/sess-1/permissions/perm-9");
    expect(call).toBeDefined();
    expect((call!.body as { response: string }).response).toBe("once");
  });
});
