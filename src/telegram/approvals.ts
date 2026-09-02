import { Bot, InlineKeyboard } from "grammy";
import { escapeHtml } from "./format";

export interface ApprovalEntry {
  sessionId: string;
  permissionId: string;
  question: string;
  createdAt: number;
}

const TTL_MS = 5 * 60 * 1000;

export class ApprovalStore {
  private entries = new Map<string, ApprovalEntry>();
  private seq = 0;

  add(sessionId: string, permissionId: string, question: string, now = Date.now()): string {
    const id = `a${++this.seq}-${now}`;
    this.entries.set(id, { sessionId, permissionId, question, createdAt: now });
    return id;
  }

  resolve(id: string, now = Date.now()): ApprovalEntry | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    this.entries.delete(id);
    if (now - e.createdAt > TTL_MS) return undefined;
    return e;
  }
}

type PermClient = {
  replyPermission(sessionId: string, permissionId: string, response: "once" | "always" | "reject"): Promise<void>;
};

export function registerApprovalHandlers(bot: Bot, store: ApprovalStore, client: PermClient): void {
  bot.callbackQuery(/^appr:(.+):(yes|no)$/, async (ctx) => {
    const id = ctx.match[1];
    const approved = ctx.match[2] === "yes";
    const entry = store.resolve(id);
    await ctx.answerCallbackQuery();
    if (!entry) {
      await ctx.editMessageText(escapeHtml("⚠️ approval expired or already handled"), { parse_mode: "HTML" }).catch(() => {});
      return;
    }
    try {
      await client.replyPermission(entry.sessionId, entry.permissionId, approved ? "once" : "reject");
      await ctx.editMessageText(
        escapeHtml(`${approved ? "✅ allowed" : "❌ denied"}: ${entry.question}`),
        { parse_mode: "HTML" }
      ).catch(() => {});
    } catch (e) {
      await ctx.editMessageText(escapeHtml(`⚠️ ${(e as Error).message}`), { parse_mode: "HTML" }).catch(() => {});
    }
  });
}
