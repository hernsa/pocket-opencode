export interface StreamRendererOpts {
  maxLen?: number;
  intervalMs?: number;
  edit?: (text: string) => void | Promise<void>;
  now?: () => number;
}

const MIN_FIRST_BATCH = 3;

export class StreamRenderer {
  private buf = "";
  private lastEdit: number;
  private firstEdit = true;
  private done = false;
  private readonly maxLen: number;
  private readonly intervalMs: number;
  private readonly edit: (text: string) => void | Promise<void>;
  private readonly now: () => number;

  constructor(opts: StreamRendererOpts = {}) {
    this.maxLen = opts.maxLen ?? 3000;
    this.intervalMs = opts.intervalMs ?? 1200;
    this.edit = opts.edit ?? (() => {});
    this.now = opts.now ?? Date.now;
    this.lastEdit = this.now();
  }

  push(delta: string): void {
    if (this.done) return;
    this.buf += delta;
    const elapsed = this.now() - this.lastEdit;
    const ready = this.firstEdit
      ? this.buf.length >= MIN_FIRST_BATCH
      : elapsed >= this.intervalMs;
    if (ready) this.flush();
  }

  finalize(): void {
    if (this.done) return;
    this.done = true;
    this.flush();
  }

  private flush(): void {
    if (this.firstEdit && this.buf.length === 0) return;
    const text = this.render();
    void this.edit(text);
    this.firstEdit = false;
    this.lastEdit = this.now();
  }

  private render(): string {
    if (this.buf.length <= this.maxLen) return this.buf;
    return "…" + this.buf.slice(this.buf.length - this.maxLen + 1);
  }
}

export interface OcEvent {
  type: string;
  properties?: unknown;
}

export interface EventSubscription {
  unsubscribe: () => void;
}

export function subscribeEvents(port: number, onEvent: (e: OcEvent) => void): EventSubscription {
  let stopped = false;
  void (async () => {
    while (!stopped) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/event`, {
          headers: { accept: "text/event-stream" },
        });
        if (!res.ok || !res.body) throw new Error(`event stream status ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          for (;;) {
            const crlf = buf.indexOf("\r\n\r\n");
            const lf = buf.indexOf("\n\n");
            const useCrlf = crlf !== -1 && (lf === -1 || crlf < lf);
            const idx = useCrlf ? crlf : lf;
            if (idx === -1) break;
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + (useCrlf ? 4 : 2));
            const dataLines = frame
              .split(/\r?\n/)
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trim());
            if (dataLines.length === 0) continue;
            try {
              const parsed = JSON.parse(dataLines.join("\n")) as OcEvent;
              if (parsed && typeof parsed.type === "string") onEvent(parsed);
            } catch {
              // non-JSON frame — ignore
            }
          }
        }
      } catch {
        // connection failed or dropped — fall through to backoff
      }
      if (!stopped) await Bun.sleep(2000);
    }
  })();
  return { unsubscribe: () => { stopped = true; } };
}
