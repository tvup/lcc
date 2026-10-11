import chalk from "chalk";

export class MarkdownRenderer {
  private buffer = "";
  private inCodeBlock = false;
  private codeLang = "";

  write(chunk: string): string {
    this.buffer += chunk;
    let output = "";

    while (this.buffer.includes("\n")) {
      const idx = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      output += this.renderLine(line) + "\n";
    }

    return output;
  }

  flush(): string {
    if (!this.buffer) return "";
    const out = this.renderLine(this.buffer);
    this.buffer = "";
    this.inCodeBlock = false;
    return out;
  }

  private renderLine(line: string): string {
    if (line.startsWith("```")) {
      this.inCodeBlock = !this.inCodeBlock;
      if (this.inCodeBlock) {
        this.codeLang = line.slice(3).trim();
        return chalk.dim(`  ┌─${this.codeLang ? ` ${this.codeLang} ` : ""}──`);
      }
      this.codeLang = "";
      return chalk.dim("  └───");
    }

    if (this.inCodeBlock) {
      return chalk.dim("  │ ") + chalk.yellow(line);
    }

    if (line.startsWith("### ")) return chalk.bold.white(line.slice(4));
    if (line.startsWith("## ")) return chalk.bold.white(line.slice(3));
    if (line.startsWith("# ")) return chalk.bold.cyan(line.slice(2));

    if (/^[-*] /.test(line)) {
      return "  " + chalk.cyan("•") + " " + this.renderInline(line.slice(2));
    }
    if (/^\d+\. /.test(line)) {
      const dot = line.indexOf(". ");
      return "  " + chalk.cyan(line.slice(0, dot + 1)) + " " + this.renderInline(line.slice(dot + 2));
    }

    return this.renderInline(line);
  }

  private renderInline(text: string): string {
    text = text.replace(/\*\*(.+?)\*\*/g, (_, m) => chalk.bold.white(m));
    text = text.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (_, m) => chalk.italic(m));
    text = text.replace(/`([^`]+)`/g, (_, m) => chalk.yellow(m));
    return text;
  }
}
