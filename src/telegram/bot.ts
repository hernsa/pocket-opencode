import { Bot, type Context, InlineKeyboard } from "grammy";
import type { AppConfig } from "../config";
import type { StateStore } from "../state";
import { escapeHtml, chunk, mdToTelegramHtml, balancePre } from "./format";
import { StreamRenderer, type OcEvent } from "../opencode/stream";
import type { PromptOpts } from "../opencode/client";
import { ApprovalStore, registerApprovalHandlers } from "./approvals";

export interface OcApi {
  health(): Promise<boolean>;
  createSession(directory: string, title?: string): Promise<string>;
  prompt(sessionId: string, text: string, opts?: PromptOpts): Promise<void>;
  abort(sessionId: string): Promise<void>;
  undo(sessionId: string): Promise<void>;
  getDiff(sessionId: string): Promise<Array<{ file: string; additions: number; deletions: number }>>;
  listModels(): Promise<Array<{ providerID: string; modelID: string }>>;
  listAgents(): Promise<string[]>;
  listSessions(directory: string): Promise<Array<{ id: string; title: string }>>;
  renameSession(sessionId: string, title: string): Promise<void>;
  replyPermission(sessionId: string, permissionId: string, response: "once" | "always" | "reject"): Promise<void>;
}

export interface BotBundle {
  bot: Bot;
  handleEvent: (e: OcEvent) => void;
  pairingCode: string;
}

const THINK_VALUES = ["low", "medium", "high", "max"] as const;

export function createBot(
  cfg: AppConfig,
  state: StateStore,
  client: OcApi,
  opts?: { print?: (s: string) => void }
): BotBundle {
  const print = opts?.print ?? ((s: string) => console.log(s));
  const pairingCode = String(Math.floor(100000 + Math.random() * 900000));
  print(pairingCode);

  const bot = new Bot(cfg.telegramToken);
  const approvals = new ApprovalStore();
  registerApprovalHandlers(bot, approvals, client);

  const renderers = new Map<string, StreamRenderer>();
  const roles = new Map<string, string>();
  const pendingRename = new Map<number, string>();
  const reasoningBuf = new Map<string, string[]>();

  function roleOf(messageId: unknown): string | undefined {
    return typeof messageId === "string" ? roles.get(messageId) : undefined;
  }

  function parseModel(v: string | undefined): { providerID: string; modelID: string } | undefined {
    if (!v) return undefined;
    const parts = v.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
    return { providerID: parts[0], modelID: parts[1] };
  }

  async function reply(ctx: Context, text: string): Promise<void> {
    for (const part of balancePre(chunk(text))) {
      await ctx.reply(part, { parse_mode: "HTML" });
    }
  }

  function activeProjectName(ctx: Context): string {
    const stored = ctx.from ? state.getActiveProject(ctx.from.id) : undefined;
    const name = stored ?? cfg.projects[0].name;
    return cfg.projects.some((p) => p.name === name) ? name : cfg.projects[0].name;
  }

  function projectByName(name: string) {
    return cfg.projects.find((p) => p.name === name) ?? cfg.projects[0];
  }

  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (uid === undefined || !cfg.allowedUserIds.includes(uid)) return;
    await next();
  });

  bot.use(async (ctx, next) => {
    const uid = ctx.from!.id;
    if (state.isPaired(uid)) return next();
    const text = ctx.message?.text;
    if (text?.startsWith("/pair ")) {
      if (text.slice(6).trim() === pairingCode) {
        state.setPairing(uid);
        await reply(ctx, "Paired. Send me a prompt to get started.");
      } else {
        await reply(ctx, "Wrong code.");
      }
      return;
    }
    await reply(ctx, "Pairing required. Send /pair &lt;code&gt; (code printed in the terminal).");
  });

  bot.command("status", async (ctx) => {
    const uid = ctx.from!.id;
    const name = activeProjectName(ctx);
    const up = await client.health().catch(() => false);
    const lines = [
      `project: ${escapeHtml(name)}`,
      `session: ${escapeHtml(state.getSession(uid, name) ?? "none")}`,
      `model: ${escapeHtml(state.getOverride(uid, "model") ?? "default")}`,
      `agent: ${escapeHtml(state.getOverride(uid, "agent") ?? "default")}`,
      `thinking: ${escapeHtml(state.getOverride(uid, "thinking") ?? "not set")}`,
      `reasoning: ${escapeHtml(state.getOverride(uid, "reasoning") ?? "off")}`,
      `opencode: ${up ? "up" : "down"}`,
    ];
    await reply(ctx, lines.join("\n"));
  });

  bot.command("new", async (ctx) => {
    const uid = ctx.from!.id;
    const proj = projectByName(activeProjectName(ctx));
    try {
      const id = await client.createSession(proj.path);
      state.setSession(uid, proj.name, id);
      await reply(ctx, `session ${escapeHtml(id.slice(0, 8))} created`);
    } catch (e) {
      await reply(ctx, `could not reach opencode: ${escapeHtml((e as Error).message)}`);
    }
  });

  bot.command("model", async (ctx) => {
    const models = await client.listModels();
    if (models.length === 0) return void reply(ctx, "no models found");
    const providers = [...new Set(models.map((m) => m.providerID))];
    const kb = new InlineKeyboard();
    for (const pid of providers) kb.text(pid, `prov:${pid}`).row();
    await ctx.reply("Pick a provider:", { reply_markup: kb });
  });

  bot.callbackQuery(/^prov:(.+)$/, async (ctx) => {
    const pid = ctx.match[1];
    const models = (await client.listModels()).filter((m) => m.providerID === pid);
    if (models.length === 0) return void reply(ctx, `no models for ${escapeHtml(pid)}`);
    const kb = new InlineKeyboard();
    for (const m of models) kb.text(`${m.providerID}/${m.modelID}`, `model:${m.providerID}/${m.modelID}`).row();
    await ctx.answerCallbackQuery();
    await ctx.reply(`Models for ${escapeHtml(pid)}:`, { reply_markup: kb });
  });

  bot.command("agent", async (ctx) => {
    const agents = await client.listAgents();
    if (agents.length === 0) return void reply(ctx, "no agents found");
    const kb = new InlineKeyboard();
    for (const a of agents.slice(0, 30)) kb.text(a, `agent:${a}`).row();
    await ctx.reply("Pick an agent:", { reply_markup: kb });
  });

  bot.command("think", async (ctx) => {
    const arg = (ctx.message?.text ?? "").split(/\s+/)[1]?.toLowerCase();
    if (!arg || !(THINK_VALUES as readonly string[]).includes(arg)) {
      return void reply(ctx, `Usage: /think &lt;${THINK_VALUES.join("|")}&gt;`);
    }
    state.setOverride(ctx.from!.id, "thinking", arg);
    await reply(ctx, `thinking stored: ${arg} (applied where opencode supports it)`);
  });

  bot.command("cd", async (ctx) => {
    const kb = new InlineKeyboard();
    for (const p of cfg.projects.slice(0, 20)) kb.text(p.name, `cd:${p.name}`).row();
    await ctx.reply("Switch project:", { reply_markup: kb });
  });

  bot.command("stop", async (ctx) => {
    const uid = ctx.from!.id;
    const sid = state.getSession(uid, activeProjectName(ctx));
    if (!sid) return void reply(ctx, "no active session");
    await client.abort(sid);
    await reply(ctx, "aborted");
  });

  bot.command("undo", async (ctx) => {
    const uid = ctx.from!.id;
    const sid = state.getSession(uid, activeProjectName(ctx));
    if (!sid) return void reply(ctx, "no active session");
    await client.undo(sid);
    await reply(ctx, "reverted last change");
  });

  bot.command("diff", async (ctx) => {
    const uid = ctx.from!.id;
    const sid = state.getSession(uid, activeProjectName(ctx));
    if (!sid) return void reply(ctx, "no active session");
    const diff = await client.getDiff(sid);
    if (diff.length === 0) return void reply(ctx, "no changes yet");
    const lines = diff.slice(0, 25).map((d) => `+${d.additions}/-${d.deletions} ${d.file}`);
    const more = diff.length > 25 ? ` and ${diff.length - 25} more` : "";
    await reply(ctx, escapeHtml(lines.join("\n")) + more);
  });

  bot.command("files", async (ctx) => {
    await reply(ctx, "/files coming soon");
  });

  bot.command("session", async (ctx) => {
    const uid = ctx.from!.id;
    const proj = projectByName(activeProjectName(ctx));
    const sessions = await client.listSessions(proj.path).catch(() => []);
    if (sessions.length === 0) return void reply(ctx, "no sessions yet");
    const active = state.getSession(uid, proj.name);
    const kb = new InlineKeyboard();
    for (const s of sessions.slice(0, 10)) {
      const label = (s.title && s.title !== s.id ? s.title : s.id.slice(0, 8)).slice(0, 30);
      kb.text(`${active === s.id ? "\u25cf " : ""}${label}`, `sess:${s.id}`).row();
    }
    await ctx.reply("Sessions:", { reply_markup: kb });
  });

  bot.callbackQuery(/^sess:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    const kb = new InlineKeyboard()
      .text("use", `sessuse:${id}`)
      .text("rename", `sessren:${id}`)
      .text("info", `sessinfo:${id}`);
    await ctx.answerCallbackQuery();
    await ctx.reply(`session ${escapeHtml(id.slice(0, 8))}`, { reply_markup: kb });
  });

  bot.callbackQuery(/^sessuse:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    state.setSession(ctx.from!.id, activeProjectName(ctx), id);
    await ctx.answerCallbackQuery();
    await reply(ctx, `switched to session ${escapeHtml(id.slice(0, 8))}`);
  });

  bot.callbackQuery(/^sessinfo:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    const active = state.getSession(ctx.from!.id, activeProjectName(ctx));
    await ctx.answerCallbackQuery();
    await reply(ctx, `session ${escapeHtml(id)}\nstatus: ${active === id ? "active for this project" : "archived"}`);
  });

  bot.callbackQuery(/^sessren:(.+)$/, async (ctx) => {
    pendingRename.set(ctx.from!.id, ctx.match[1]);
    await ctx.answerCallbackQuery();
    await reply(ctx, "send the new title");
  });

  bot.command("reasoning", async (ctx) => {
    const arg = (ctx.message?.text ?? "").split(/\s+/)[1]?.toLowerCase();
    if (arg !== "on" && arg !== "off") {
      return void reply(ctx, "Usage: /reasoning &lt;on|off&gt;");
    }
    state.setOverride(ctx.from!.id, "reasoning", arg);
    await reply(ctx, arg === "on" ? "thinking chains will be sent after each answer" : "thinking chains off");
  });

  bot.callbackQuery(/^model:(.+)$/, async (ctx) => {
    const value = ctx.match[1];
    state.setOverride(ctx.from!.id, "model", value);
    await ctx.answerCallbackQuery();
    await reply(ctx, `model set to ${escapeHtml(value)}`);
  });

  bot.callbackQuery(/^agent:(.+)$/, async (ctx) => {
    const value = ctx.match[1];
    state.setOverride(ctx.from!.id, "agent", value);
    await ctx.answerCallbackQuery();
    await reply(ctx, `agent set to ${escapeHtml(value)}`);
  });

  bot.callbackQuery(/^cd:(.+)$/, async (ctx) => {
    const value = ctx.match[1];
    state.setActiveProject(ctx.from!.id, value);
    await ctx.answerCallbackQuery();
    await reply(ctx, `switched to ${escapeHtml(value)}`);
  });

  bot.on("message:text", async (ctx) => {
    const uid = ctx.from!.id;
    const text = ctx.message.text;
    if (text.startsWith("/")) return;
    if (pendingRename.has(uid)) {
      const id = pendingRename.get(uid)!;
      pendingRename.delete(uid);
      try {
        await client.renameSession(id, text);
        await reply(ctx, `renamed to ${escapeHtml(text)}`);
      } catch (e) {
        await reply(ctx, `rename failed: ${escapeHtml((e as Error).message)}`);
      }
      return;
    }
    const proj = projectByName(activeProjectName(ctx));
    let sid = state.getSession(uid, proj.name);
    if (!sid) {
      try {
        sid = await client.createSession(proj.path);
        state.setSession(uid, proj.name, sid);
      } catch (e) {
        await reply(ctx, `could not reach opencode: ${escapeHtml((e as Error).message)}`);
        return;
      }
    }
    const placeholder = await ctx.reply(`working on ${escapeHtml(proj.name)}...`);
    const chatId = ctx.chat!.id;
    const msgId = placeholder.message_id;
    renderers.set(sid, new StreamRenderer({
      edit: (t) => {
        void ctx.api.editMessageText(chatId, msgId, mdToTelegramHtml(t), { parse_mode: "HTML" }).catch(() => {});
      },
    }));
    try {
      await client.prompt(sid, text, {
        directory: proj.path,
        model: parseModel(state.getOverride(uid, "model")),
        agent: state.getOverride(uid, "agent"),
      });
    } catch (e) {
      renderers.get(sid)?.finalize();
      renderers.delete(sid);
      await reply(ctx, `${escapeHtml((e as Error).message)}`);
    }
  });

  const handleEvent = (e: OcEvent): void => {
    const props = (e.properties ?? {}) as Record<string, unknown>;
    if (e.type === "message.updated") {
      const info = props["info"] as { id?: unknown; role?: unknown } | undefined;
      if (info && typeof info.id === "string" && typeof info.role === "string") {
        roles.set(info.id, info.role);
      }
      return;
    }
    if (e.type === "message.part.delta") {
      const sid = typeof props["sessionID"] === "string" ? props["sessionID"] : undefined;
      if (!sid) return;
      const delta = props["delta"];
      if (typeof delta !== "string" || delta.length === 0) return;
      if (roleOf(props["messageID"]) !== "assistant") return;
      if (props["field"] === "reasoning") {
        const buf = reasoningBuf.get(sid) ?? [];
        buf.push(delta);
        reasoningBuf.set(sid, buf);
        return;
      }
      if (props["field"] !== "text") return;
      renderers.get(sid)?.push(delta);
      return;
    }
    if (e.type === "message.part.updated") {
      const part = props["part"] as
        | { sessionID?: string; type?: string; text?: string; messageID?: unknown }
        | undefined;
      const delta = props["delta"];
      const sid = typeof props["sessionID"] === "string" ? props["sessionID"] : part?.sessionID;
      if (!sid) return;
      const r = renderers.get(sid);
      if (!r) return;
      if (typeof delta === "string" && delta.length > 0) {
        r.push(delta);
        return;
      }
      if (part?.type === "text" && typeof part.text === "string" && roleOf(part.messageID) === "assistant") {
        r.replace(part.text);
      }
      return;
    }
    if (e.type === "session.idle") {
      const sid = props["sessionID"];
      if (typeof sid !== "string") return;
      const r = renderers.get(sid);
      if (r) {
        r.finalize();
        renderers.delete(sid);
      }
      void bot.api.sendMessage(cfg.allowedUserIds[0], "done").catch(() => {});
      const thinking = reasoningBuf.get(sid);
      if (thinking && thinking.length > 0) {
        reasoningBuf.delete(sid);
        if (state.getOverride(cfg.allowedUserIds[0], "reasoning") === "on") {
          void (async () => {
            for (const part of balancePre(chunk(thinking.join("")))) {
              await bot.api.sendMessage(cfg.allowedUserIds[0], `\ud83e\udde0 thinking\n${mdToTelegramHtml(part)}`, { parse_mode: "HTML" }).catch(() => {});
            }
          })();
        }
      }
      return;
    }
    if (e.type === "session.error") {
      const sid = typeof props["sessionID"] === "string" ? props["sessionID"] : undefined;
      const errMsg = typeof props["message"] === "string"
        ? props["message"]
        : ((props["error"] as { data?: { message?: string } } | undefined)?.data?.message
          ?? (props["error"] as { message?: string } | undefined)?.message
          ?? "unknown error");
      if (sid) {
        const r = renderers.get(sid);
        if (r) {
          r.finalize();
          renderers.delete(sid);
        }
      }
      void bot.api.sendMessage(cfg.allowedUserIds[0], `${escapeHtml(errMsg)}`).catch(() => {});
      return;
    }
    if (e.type === "permission.updated") {
      const permission = props as { id?: string; sessionID?: string; title?: string };
      if (!permission.id || !permission.sessionID) return;
      const approvalId = approvals.add(permission.sessionID, permission.id, permission.title ?? "permission");
      const kb = new InlineKeyboard()
        .text("Allow", `appr:${approvalId}:yes`)
        .text("Deny", `appr:${approvalId}:no`);
      void bot.api.sendMessage(cfg.allowedUserIds[0], `Permission requested: ${escapeHtml(permission.title ?? "permission")}`, { reply_markup: kb }).catch(() => {});
      return;
    }
  };

  bot.catch((err) => {
    console.error("[bot] handler error:", err.error);
  });

  return { bot, handleEvent, pairingCode };
}
