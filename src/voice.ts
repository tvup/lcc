import { spawn, execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type * as readline from "node:readline/promises";
import chalk from "chalk";
import WebSocket from "ws";
import { CONFIG_DIR } from "./config.js";
import { t } from "./i18n.js";

export type VoiceProvider = "off" | "deepgram" | "whisper";

export interface VoiceSettings {
  provider: VoiceProvider;
  language: string;
  deepgramApiKey?: string;
  openaiApiKey?: string;
}

const VOICE_FILE = join(CONFIG_DIR, "voice.json");
const SAMPLE_RATE = 16000;
const DEEPGRAM_URL = "wss://api.deepgram.com/v1/listen";
const WHISPER_URL = "https://api.openai.com/v1/audio/transcriptions";
const DEEPGRAM_CLOSE_TIMEOUT_MS = 5000;

export const PROVIDER_LABELS: Record<Exclude<VoiceProvider, "off">, string> = {
  get deepgram() { return t("voice.deepgram_label"); },
  get whisper() { return t("voice.whisper_label"); },
};

export function loadVoiceSettings(): VoiceSettings {
  const defaults: VoiceSettings = { provider: "off", language: "da" };
  try {
    const parsed = JSON.parse(readFileSync(VOICE_FILE, "utf-8")) as Partial<VoiceSettings>;
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

export function saveVoiceSettings(settings: VoiceSettings): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(VOICE_FILE, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  chmodSync(VOICE_FILE, 0o600);
}

export function apiKeyFor(settings: VoiceSettings, provider: Exclude<VoiceProvider, "off">): string | undefined {
  return provider === "deepgram"
    ? process.env["DEEPGRAM_API_KEY"] || settings.deepgramApiKey
    : process.env["OPENAI_API_KEY"] || settings.openaiApiKey;
}

interface Recorder {
  cmd: string;
  args: string[];
}

let cachedRecorder: Recorder | null | undefined;

export function findRecorder(): Recorder | null {
  if (cachedRecorder !== undefined) return cachedRecorder;
  const has = (bin: string): boolean => {
    try {
      execSync(`command -v ${bin}`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  const rate = String(SAMPLE_RATE);
  if (process.platform === "linux" && has("arecord")) {
    cachedRecorder = { cmd: "arecord", args: ["-q", "-f", "S16_LE", "-r", rate, "-c", "1", "-t", "raw"] };
  } else if (has("rec")) {
    cachedRecorder = { cmd: "rec", args: ["-q", "-r", rate, "-c", "1", "-b", "16", "-e", "signed-integer", "-t", "raw", "-"] };
  } else {
    cachedRecorder = null;
  }
  return cachedRecorder;
}

export function recorderInstallHint(): string {
  return process.platform === "darwin"
    ? t("voice.recorder_install_mac")
    : t("voice.recorder_install_linux");
}

interface Transcriber {
  push(chunk: Buffer): void;
  finish(): Promise<string>;
  abort(): void;
}

export class DeepgramTranscriber implements Transcriber {
  private ws: WebSocket;
  private queue: Buffer[] = [];
  private finals: string[] = [];
  private interim = "";
  private finishing = false;
  private failed: Error | null = null;
  private closed: Promise<void>;
  private markClosed!: () => void;

  constructor(
    apiKey: string,
    language: string,
    private onInterim: (text: string) => void,
    private onError: (err: Error) => void,
    url = DEEPGRAM_URL,
  ) {
    this.closed = new Promise((resolve) => { this.markClosed = resolve; });
    const params = new URLSearchParams({
      model: "nova-3",
      language,
      encoding: "linear16",
      sample_rate: String(SAMPLE_RATE),
      channels: "1",
      interim_results: "true",
      smart_format: "true",
    });
    this.ws = new WebSocket(`${url}?${params}`, { headers: { Authorization: `Token ${apiKey}` } });

    this.ws.on("open", () => {
      for (const chunk of this.queue) this.ws.send(chunk);
      this.queue = [];
      if (this.finishing) this.ws.send(JSON.stringify({ type: "CloseStream" }));
    });
    this.ws.on("message", (data) => this.handleMessage(data.toString()));
    this.ws.on("unexpected-response", (req, res) => {
      const reason = res.headers["dg-error"] ?? res.statusMessage;
      this.fail(new Error(t("voice.deepgram_rejected", String(res.statusCode), reason ? `: ${reason}` : "")));
      req.destroy();
    });
    this.ws.on("error", (err) => this.fail(new Error(`Deepgram: ${err.message}`)));
    this.ws.on("close", () => this.markClosed());
  }

  push(chunk: Buffer): void {
    if (this.failed) return;
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(chunk);
    } else if (this.ws.readyState === WebSocket.CONNECTING) {
      this.queue.push(chunk);
    }
  }

  async finish(): Promise<string> {
    if (this.failed) throw this.failed;
    this.finishing = true;
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "CloseStream" }));
    }
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, DEEPGRAM_CLOSE_TIMEOUT_MS).unref());
    await Promise.race([this.closed, timeout]);
    if (this.failed) throw this.failed;
    this.ws.terminate();
    return this.current();
  }

  abort(): void {
    this.ws.terminate();
  }

  private current(): string {
    return [...this.finals, this.interim].filter(Boolean).join(" ");
  }

  private handleMessage(raw: string): void {
    let msg: { type?: string; is_final?: boolean; channel?: { alternatives?: Array<{ transcript?: string }> } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type !== "Results") return;
    const text = msg.channel?.alternatives?.[0]?.transcript ?? "";
    if (msg.is_final) {
      if (text) this.finals.push(text);
      this.interim = "";
    } else {
      this.interim = text;
    }
    this.onInterim(this.current());
  }

  private fail(err: Error): void {
    if (this.failed) return;
    this.failed = err;
    this.onError(err);
    this.markClosed();
  }
}

export class WhisperTranscriber implements Transcriber {
  private chunks: Buffer[] = [];
  private abortController = new AbortController();

  constructor(private apiKey: string, private language: string, private url = WHISPER_URL) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
  }

  async finish(): Promise<string> {
    const pcm = Buffer.concat(this.chunks);
    if (pcm.length < SAMPLE_RATE * 2 * 0.3) return "";

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(pcmToWav(pcm))], { type: "audio/wav" }), "tale.wav");
    form.append("model", "whisper-1");
    form.append("language", this.language);

    const res = await fetch(this.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: this.abortController.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      let detail = body;
      try {
        detail = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? body;
      } catch { /* use raw body */ }
      throw new Error(`Whisper: HTTP ${res.status}: ${detail}`);
    }
    return ((await res.json()) as { text?: string }).text?.trim() ?? "";
  }

  abort(): void {
    this.abortController.abort();
  }
}

function pcmToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export interface VoiceSession {
  stop(): Promise<string>;
  abort(): void;
}

export type SessionFactory = (
  settings: VoiceSettings,
  onInterim: (text: string) => void,
  onError: (err: Error) => void,
) => VoiceSession;

export const startVoiceSession: SessionFactory = (settings, onInterim, onError) => {
  if (settings.provider === "off") throw new Error(t("voice.is_off"));
  const provider = settings.provider;
  const key = apiKeyFor(settings, provider);
  if (!key) {
    throw new Error(provider === "deepgram"
      ? t("voice.missing_deepgram_key")
      : t("voice.missing_openai_key"));
  }
  const recorder = findRecorder();
  if (!recorder) throw new Error(t("voice.no_recorder", recorderInstallHint()));

  const transcriber: Transcriber = provider === "deepgram"
    ? new DeepgramTranscriber(key, settings.language, onInterim, onError)
    : new WhisperTranscriber(key, settings.language);

  const proc = spawn(recorder.cmd, recorder.args, { stdio: ["ignore", "pipe", "pipe"] });
  let stopping = false;
  let stderr = "";
  proc.stderr.on("data", (d: Buffer) => { stderr = (stderr + d.toString()).slice(-500); });
  proc.stdout.on("data", (chunk: Buffer) => transcriber.push(chunk));
  const exited = new Promise<void>((resolve) => {
    proc.on("close", (code) => {
      if (!stopping && code) {
        onError(new Error(t("voice.recorder_stopped", recorder.cmd, String(code), stderr.trim() || t("voice.no_error"))));
      }
      resolve();
    });
    proc.on("error", (err) => {
      onError(new Error(t("voice.recorder_start_failed", recorder.cmd, err.message)));
      resolve();
    });
  });

  return {
    async stop() {
      stopping = true;
      proc.kill("SIGTERM");
      await exited;
      return transcriber.finish();
    },
    abort() {
      stopping = true;
      proc.kill("SIGTERM");
      transcriber.abort();
    },
  };
};

// Terminals send no key-up events, so a held space is recognised by its auto-repeat:
// the first repeat comes after the OS repeat delay, later ones arrive in a fast stream.
const HOLD_SPACES = 4;
const HOLD_GAP_MS = 130;
const BURST_RESET_MS = 1000;
const RELEASE_MS = 350;

type Key = { name?: string; ctrl?: boolean; meta?: boolean } | undefined;
type EditableInterface = readline.Interface & { line: string; cursor: number };

export class VoiceInput {
  active = false;
  private spaceTimes: number[] = [];
  private state: "idle" | "recording" | "transcribing" = "idle";
  private session: VoiceSession | null = null;
  private sessionId = 0;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private prefix = "";
  private suffix = "";

  constructor(
    private rl: readline.Interface,
    private out: NodeJS.WriteStream,
    private normalPrompt: string,
    private getSettings: () => VoiceSettings,
    private createSession: SessionFactory = startVoiceSession,
  ) {}

  onKeypress(key: Key): void {
    if (this.getSettings().provider === "off") return;
    const isSpace = key?.name === "space" && !key.ctrl && !key.meta;

    if (this.state !== "idle") {
      if (key?.name === "return" || key?.name === "enter") {
        this.cancel();
      } else if (this.state === "recording") {
        if (isSpace) {
          this.rl.write(null, { name: "backspace" });
          this.armRelease();
        } else {
          void this.release();
        }
      }
      return;
    }

    if (!this.active || !isSpace) {
      this.spaceTimes = [];
      return;
    }
    const now = Date.now();
    const last = this.spaceTimes[this.spaceTimes.length - 1];
    if (last !== undefined && now - last > BURST_RESET_MS) this.spaceTimes = [];
    this.spaceTimes.push(now);
    if (this.spaceTimes.length < HOLD_SPACES) return;

    const recent = this.spaceTimes.slice(-HOLD_SPACES);
    const repeatGaps = recent.slice(2).map((t, i) => t - recent[i + 1]!);
    if (repeatGaps.every((gap) => gap <= HOLD_GAP_MS)) {
      this.start(this.spaceTimes.length);
    }
  }

  /** Stops any recording or transcription; returns whether one was running. */
  dispose(): boolean {
    if (this.state === "idle") return false;
    this.cancel();
    return true;
  }

  private start(burstSpaces: number): void {
    this.spaceTimes = [];
    const rl = this.rl as EditableInterface;
    let before = rl.line.slice(0, rl.cursor);
    for (let i = 0; i < burstSpaces && before.endsWith(" "); i++) before = before.slice(0, -1);
    this.prefix = before;
    this.suffix = rl.line.slice(rl.cursor);

    const id = ++this.sessionId;
    try {
      this.session = this.createSession(
        this.getSettings(),
        (text) => { if (id === this.sessionId && this.state !== "idle") this.render(text); },
        (err) => { if (id === this.sessionId) this.fail(err); },
      );
    } catch (err) {
      this.render("");
      this.showError(err);
      return;
    }
    this.state = "recording";
    this.rl.setPrompt(chalk.red("● "));
    this.render("");
    this.armRelease();
  }

  private armRelease(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => void this.release(), RELEASE_MS);
  }

  private clearReleaseTimer(): void {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
  }

  private async release(): Promise<void> {
    if (this.state !== "recording" || !this.session) return;
    this.clearReleaseTimer();
    this.state = "transcribing";
    const id = this.sessionId;
    const session = this.session;
    this.rl.setPrompt(chalk.dim("… "));
    this.rl.prompt(true);
    try {
      const text = await session.stop();
      if (id !== this.sessionId) return;
      this.reset();
      this.render(text);
    } catch (err) {
      if (id === this.sessionId) this.fail(err);
    }
  }

  private cancel(): void {
    this.sessionId++;
    this.session?.abort();
    this.reset();
  }

  private fail(err: unknown): void {
    this.sessionId++;
    this.session?.abort();
    this.reset();
    this.render("");
    this.showError(err);
  }

  private reset(): void {
    this.clearReleaseTimer();
    this.state = "idle";
    this.session = null;
    this.rl.setPrompt(this.normalPrompt);
  }

  private render(text: string): void {
    if (!this.active) return;
    const sep = text && this.prefix && !this.prefix.endsWith(" ") ? " " : "";
    const before = this.prefix + sep + text;
    const rl = this.rl as EditableInterface;
    rl.line = before + this.suffix;
    rl.cursor = before.length;
    this.rl.prompt(true);
  }

  private showError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.out.write(`\r\x1b[2K${chalk.red(`  ${t("voice.error_prefix", msg)}`)}\n`);
    this.rl.prompt(true);
  }
}
