import { resolve } from "node:path";
import { loadConfig } from "./config";
import { openState } from "./state";
import { OpencodeClient } from "./opencode/client";
import { createBot } from "./telegram/bot";
import { subscribeEvents } from "./opencode/stream";
import { opencodeAuthHeaders } from "./opencode/client";

const CONFIG_PATH = process.env["POCKET_CONFIG"] ?? resolve(process.cwd(), "config.json");

async function main(): Promise<void> {
  const cfg = loadConfig(CONFIG_PATH);
  const state = openState(cfg.dbPath);
  const client = new OpencodeClient({ port: cfg.opencodePort });

  console.log(`[pocket] ensuring opencode serve on 127.0.0.1:${cfg.opencodePort}`);
  await client.ensureRunning();
  console.log("[pocket] opencode is up");

  const bundle = createBot(cfg, state, client);
  subscribeEvents(cfg.opencodePort, bundle.handleEvent, { headers: opencodeAuthHeaders() });

  console.log("[pocket] telegram bot starting (long polling)");
  await bundle.bot.start({
    onStart: () => {
      console.log("[pocket] bot is live. Pairing code printed above.");
      console.log("[pocket] Ctrl+C to stop.");
    },
  });

  const shutdown = async (): Promise<void> => {
    console.log("\n[pocket] shutting down");
    await bundle.bot.stop().catch(() => {});
    state.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((e) => {
  console.error("[pocket] fatal:", e);
  process.exit(1);
});
