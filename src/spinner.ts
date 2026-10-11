import chalk from "chalk";

const FRAMES = ["( ● ● )", "( ● ● )", "( ● ● )", "( - - )", "( ● ● )", "( ● ● )", "( ●  ●)", "( ●  ●)", "( ● ● )", "(●  ● )", "(●  ● )"];
const DOTS = ["   ", ".  ", ".. ", "..."];
const INTERVAL_MS = 150;

export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private startedAt = 0;
  private label = "";

  constructor(private out: NodeJS.WriteStream) {}

  start(label: string): void {
    if (!this.out.isTTY) return;
    this.stop();
    this.label = label;
    this.frame = 0;
    this.startedAt = Date.now();
    this.out.write("\x1b[?25l");
    this.render();
    this.timer = setInterval(() => this.render(), INTERVAL_MS);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.out.write("\r\x1b[2K\x1b[?25h");
  }

  private render(): void {
    const face = FRAMES[this.frame % FRAMES.length]!;
    const dots = DOTS[Math.floor(this.frame / 3) % DOTS.length]!;
    const secs = Math.floor((Date.now() - this.startedAt) / 1000);
    const elapsed = secs > 0 ? chalk.dim(` ${secs}s`) : "";
    this.out.write(`\r\x1b[2K  ${chalk.cyan(face)} ${chalk.dim(this.label + dots)}${elapsed}`);
    this.frame++;
  }
}
