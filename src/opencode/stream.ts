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
