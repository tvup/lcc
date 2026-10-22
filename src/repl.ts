import * as readline from "node:readline/promises";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { stdin, stdout } from "node:process";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { LibreChatClient, type InputItem, type ContentPart } from "./client.js";
import { loadConfig, saveConfig, CONFIG_DIR } from "./config.js";
import { MarkdownRenderer } from "./markdown.js";
import type { McpManager } from "./mcp.js";
import { loadSkills, findSkill, renderSkill, type Skill } from "./skills.js";
import { loadAddons, detectAddons } from "./addons.js";
import { Spinner } from "./spinner.js";
import { t, setLocale, getLocale, confirmYes, confirmHint } from "./i18n.js";
import {
  VoiceInput,
  loadVoiceSettings,
  saveVoiceSettings,
  apiKeyFor,
  findRecorder,
  recorderInstallHint,
  PROVIDER_LABELS,
  type VoiceSettings,
} from "./voice.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as { version: string };

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);

function isImageFile(path: string): boolean {
  return IMAGE_EXTS.has(extname(path).toLowerCase());
}

function textOfContent(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content.filter((p) => p.type === "input_text").map((p) => (p as { text: string }).text).join(" ");
}

function findAtToken(line: string, cursor: number): { partial: string; start: number } | null {
  let i = cursor - 1;
  while (i >= 0 && line[i] !== " " && line[i] !== "\t") i--;
  i++;
  if (line[i] !== "@") return null;
  return { partial: line.slice(i + 1, cursor), start: i };
}

function matchFiles(partial: string): Array<{ path: string; isDir: boolean }> {
  const cwd = process.cwd();
  const dir = partial.includes("/") ? dirname(partial) : ".";
  const prefix = partial.includes("/") ? basename(partial) : partial;
  const absDir = resolve(cwd, dir);

  try {
    const entries = readdirSync(absDir, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith(".") && e.name.toLowerCase().startsWith(prefix.toLowerCase()))
      .slice(0, 8)
      .map((e) => ({
        path: dir === "." ? e.name : join(dir, e.name),
        isDir: e.isDirectory(),
      }));
  } catch {
    return [];
  }
}

function buildMultiPartMessage(text: string): InputItem {
  const atPattern = /@((?:[^\s@?!,;:(){}[\]]|(?<=\\) )+)/g;
  const parts: ContentPart[] = [];
  const filePaths: string[] = [];
  let cleanText = text;
  let match: RegExpExecArray | null;
  const cwd = process.cwd();

  while ((match = atPattern.exec(text)) !== null) {
    const rawPath = match[1]!.replace(/\\ /g, " ");
    const absPath = resolve(cwd, rawPath);
    if (!existsSync(absPath) || statSync(absPath).isDirectory()) continue;
    filePaths.push(rawPath);
  }

  if (filePaths.length === 0) {
    return { type: "message", role: "user", content: text };
  }

  for (const fp of filePaths) {
    cleanText = cleanText.replace(new RegExp(`@${fp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g"), "").trim();
  }

  const textParts: string[] = [];
  if (cleanText) textParts.push(cleanText);

  for (const fp of filePaths) {
    const absPath = resolve(cwd, fp);
    if (isImageFile(fp)) {
      try {
        const data = readFileSync(absPath);
        const ext = extname(fp).toLowerCase().replace(".", "");
        const mime = ext === "jpg" ? "jpeg" : ext === "svg" ? "svg+xml" : ext;
        parts.push({ type: "input_image", image_url: `data:image/${mime};base64,${data.toString("base64")}` });
      } catch { /* skip unreadable */ }
    } else {
      try {
        const content = readFileSync(absPath, "utf-8");
        textParts.push(`[File: ${fp}]\n\`\`\`\n${content}\n\`\`\``);
      } catch { /* skip unreadable */ }
    }
  }

  if (textParts.length > 0) {
    parts.unshift({ type: "input_text", text: textParts.join("\n\n") });
  }

  return { type: "message", role: "user", content: parts };
}

export async function startRepl(client: LibreChatClient, mcp?: McpManager): Promise<void> {
  const history: InputItem[] = [];
  let abortController: AbortController | null = null;
  const spinner = new Spinner(stdout);

  const commandDefs = [
    { cmd: "/help", desc: t("cmd.help") },
    { cmd: "/clear", desc: t("cmd.clear") },
    { cmd: "/config", desc: t("cmd.config") },
    { cmd: "/model", desc: t("cmd.model") },
    { cmd: "/models", desc: t("cmd.models") },
    { cmd: "/save", desc: t("cmd.save") },
    { cmd: "/load", desc: t("cmd.load") },
    { cmd: "/tools", desc: t("cmd.tools") },
    { cmd: "/mcp", desc: t("cmd.mcp") },
    { cmd: "/addons", desc: t("cmd.addons") },
    { cmd: "/update", desc: t("cmd.update") },
    { cmd: "/restart", desc: t("cmd.restart") },
    { cmd: "/voice", desc: t("cmd.voice") },
    { cmd: "/exit", desc: t("cmd.exit") },
  ];
  const skills = loadSkills();
  const skillDefs = skills.map((s) => ({
    cmd: `/${s.name}`,
    desc: s.description || (s.source === "project" ? t("repl.skill_source_project") : t("repl.skill_source_user")),
  }));
  const commands = [...commandDefs.map((c) => c.cmd), ...skillDefs.map((s) => s.cmd), "/quit"];
  let cachedModelIds: string[] = [];
  let hintLines = 0;
  let modelsFetched = false;

  function ensureModelsCached(): void {
    if (modelsFetched) return;
    modelsFetched = true;
    client.listModels().then((models) => {
      cachedModelIds = models.map((m) => m.id);
    }).catch(() => {});
  }

  function completer(line: string): [string[], string] {
    if (line.startsWith("/model ")) {
      ensureModelsCached();
      const partial = line.slice(7);
      const hits = cachedModelIds.filter((id) => id.startsWith(partial));
      return [hits.map((h) => `/model ${h}`), line];
    }
    if (line.startsWith("/")) {
      const hits = commands.filter((c) => c.startsWith(line));
      return [hits, line];
    }
    const cursor = (rl as unknown as { cursor: number }).cursor ?? line.length;
    const at = findAtToken(line, cursor);
    if (at) {
      const matches = matchFiles(at.partial);
      if (matches.length > 0) {
        const prefix = line.slice(0, at.start) + "@";
        const completions = matches.map((m) => prefix + m.path + (m.isDir ? "/" : "") + line.slice(cursor));
        return [completions, line];
      }
    }
    return [[], line];
  }

  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    completer,
    history: loadInputHistory(),
    historySize: INPUT_HISTORY_SIZE,
    removeHistoryDuplicates: true,
  });
  rl.on("history", (lines: string[]) => saveInputHistory(lines));

  const mainPrompt = chalk.green("❯ ");
  let voiceSettings = loadVoiceSettings();
  const voice = new VoiceInput(rl, stdout, mainPrompt, () => voiceSettings);

  const PROMPT_WIDTH = 2; // visible chars in "❯ "

  function cursorScreenCol(): number {
    const cols = stdout.columns || 80;
    const cursor = (rl as unknown as { cursor: number }).cursor ?? 0;
    return ((PROMPT_WIDTH + cursor) % cols) + 1;
  }

  function inputWrapRows(): number {
    const cols = stdout.columns || 80;
    const lineLen = ((rl as unknown as { line: string }).line ?? "").length;
    return Math.floor((PROMPT_WIDTH + lineLen) / cols);
  }

  function clearHints(): void {
    if (hintLines === 0) return;
    for (let i = 0; i < hintLines; i++) {
      stdout.write("\n\x1b[2K");
    }
    stdout.write(`\x1b[${hintLines}A\x1b[${cursorScreenCol()}G`);
    hintLines = 0;
  }

  function showHints(line: string): void {
    clearHints();

    let hints: Array<{ label: string; desc: string; matchLen: number }> = [];

    if (line.startsWith("/model ")) {
      const partial = line.slice(7);
      if (partial) {
        hints = cachedModelIds
          .filter((id) => id.startsWith(partial))
          .slice(0, 6)
          .map((id) => ({ label: `/model ${id}`, desc: "", matchLen: line.length }));
      }
    } else if (line.startsWith("/")) {
      hints = [...commandDefs, ...skillDefs]
        .filter((c) => c.cmd.startsWith(line))
        .map((c) => ({ label: c.cmd, desc: c.desc, matchLen: line.length }));
    }

    if (hints.length === 0) {
      const cursor = (rl as unknown as { cursor: number }).cursor ?? line.length;
      const at = findAtToken(line, cursor);
      if (at && at.partial.length > 0) {
        const matches = matchFiles(at.partial);
        hints = matches.map((m) => {
          const icon = m.isDir ? "📁" : isImageFile(m.path) ? "🖼" : "📄";
          return { label: `@${m.path}${m.isDir ? "/" : ""}`, desc: icon, matchLen: 1 + at.partial.length };
        });
      }
    }

    if (hints.length === 0) return;

    // Skip hints when input wraps — cursor restoration is unreliable across wrapped rows
    const wrapRows = inputWrapRows();
    if (wrapRows > 0 && !line.startsWith("/")) return;

    const width = (stdout.columns || 80) - 1;
    for (const h of hints) {
      const label = h.label.slice(0, Math.max(0, width - 3));
      const room = width - 3 - label.length - 2;
      let desc = h.desc;
      if (desc.length > room) desc = room > 1 ? desc.slice(0, room - 1) + "…" : "";
      const highlighted =
        chalk.dim("   ") +
        chalk.bold.white(label.slice(0, h.matchLen)) +
        chalk.cyan(label.slice(h.matchLen)) +
        (desc ? chalk.dim(`  ${desc}`) : "");
      stdout.write(`\n\x1b[2K${highlighted}`);
    }
    hintLines = hints.length;
    stdout.write(`\x1b[${hintLines}A\x1b[${cursorScreenCol()}G`);
  }

  if (stdin.isTTY) {
    // Must run before readline handles Enter: readline moves the cursor onto the
    // hint rows, and clearHints() assumes the cursor is still on the prompt line.
    stdin.prependListener("keypress", (_str: unknown, key: { name?: string } | undefined) => {
      if (key?.name === "return" || key?.name === "enter") clearHints();
    });
    stdin.on("keypress", (_str: unknown, key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined) => {
      voice.onKeypress(key);
      if (key?.name === "return" || key?.name === "enter") return;
      process.nextTick(() => {
        const line = (rl as unknown as { line: string }).line;
        showHints(line ?? "");
      });
    });
  }

  // In raw mode Ctrl+C reaches readline as a key, not as a process signal.
  const onInterrupt = (): void => {
    clearHints();
    spinner.stop();
    const voiceWasBusy = voice.dispose();
    const editable = rl as unknown as { line: string; cursor: number };
    if (abortController) {
      abortController.abort();
      abortController = null;
      stdout.write("\n");
    } else if (editable.line || voiceWasBusy) {
      editable.line = "";
      editable.cursor = 0;
      rl.prompt(true);
    } else {
      // Without a SIGINT listener readline rejects the pending question and closes,
      // which lets the REPL loop run its normal shutdown.
      rl.off("SIGINT", onInterrupt);
      rl.write(null, { ctrl: true, name: "c" });
    }
  };
  rl.on("SIGINT", onInterrupt);
  process.on("SIGINT", onInterrupt);

  const agent = client.getAgent();
  const modeLabel = client.isAgentMode() ? "Agent" : "Model";
  const toolLine = chalk.dim(`   Tools: ${client.getToolsEnabled() ? chalk.green(t("repl.tools_on_short")) : chalk.red(t("repl.tools_off_short"))}`);
  const mcpCount = mcp?.toolCount() ?? 0;
  const mcpLine = mcpCount > 0
    ? chalk.dim(`   MCP: ${mcp!.getServerNames().length} ${mcp!.getServerNames().length > 1 ? t("repl.server_many") : t("repl.server_one")}, ${mcpCount} tools`)
    : "";
  const hasAgentsMd = existsSync(join(process.cwd(), "AGENTS.md"));
  const hasClaudeMd = existsSync(join(process.cwd(), "CLAUDE.md"));
  let instrLine = "";
  if (hasAgentsMd) {
    instrLine = `   ${t("repl.instructions_loaded", "AGENTS.md")}`;
  } else if (hasClaudeMd) {
    instrLine = chalk.rgb(35, 35, 35)(`   ${t("repl.instructions_loaded", "CLAUDE.md")}`);
  }
  const matched = client.getMatchedAddons();
  const addonLine = matched.length > 0
    ? chalk.dim(`   ${t("repl.addons_active", matched.map((a) => a.name).join(", "))}`)
    : "";
  const infoLines = [mcpLine, instrLine, addonLine].filter(Boolean);
  let banner =
    "\n" +
    chalk.cyan("    /\\_/\\") + "   " + chalk.bold.cyan("lcc") + chalk.dim(` v${PKG.version} — LibreChat Code`) + "\n" +
    chalk.cyan("   ( ● ● )") + chalk.dim(`  ${modeLabel}: ${agent}`) + "\n" +
    chalk.cyan("    > ▽ <") + toolLine + "\n" +
    chalk.cyan("   /|   |\\") + (infoLines[0] || chalk.dim(`  ${t("repl.help_commands")}`)) + "\n" +
    chalk.cyan("  (_|   |_)") + (infoLines[1] || (infoLines[0] ? chalk.dim(`  ${t("repl.help_commands")}`) : ""));
  for (let i = 2; i < infoLines.length; i++) {
    banner += "\n" + " ".repeat(11) + infoLines[i];
  }
  console.log(banner + "\n");

  const sessions = listSessions();
  if (sessions.length > 0) {
    console.log(chalk.dim(`  ${t("repl.sessions_header")}`));
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i]!;
      const idx = chalk.cyan(String(i + 1));
      const preview = s.preview.length > 50 ? s.preview.slice(0, 50) + "…" : s.preview;
      const date = chalk.dim(s.date);
      const msgs = chalk.dim(`(${s.msgCount})`);
      console.log(`  ${idx}. ${preview}  ${msgs}  ${date}`);
    }
    console.log("");
    try {
      const answer = await rl.question(chalk.dim(`  ${t("repl.session_select", sessions.length)} `));
      const trimmedAnswer = answer.trim();
      if (trimmedAnswer === "0") {
        console.log(chalk.dim(`  ${t("repl.new_session")}\n`));
      } else {
        const idx = trimmedAnswer === "" ? 0 : parseInt(trimmedAnswer, 10) - 1;
        const picked = sessions[idx];
        if (picked) {
          const items = loadSessionFile(picked.file);
          if (items.length > 0) {
            history.push(...items);
            console.log(chalk.dim(`  ${t("repl.messages_loaded", items.length)}\n`));
          }
        }
      }
    } catch { /* ignore */ }
  }

  checkForUpdate();

  while (true) {
    let input: string;
    voice.active = true;
    try {
      input = await rl.question(mainPrompt);
    } catch {
      break;
    } finally {
      voice.active = false;
    }

    clearHints();

    // Multiline: if line ends with \, keep reading
    while (input.endsWith("\\")) {
      input = input.slice(0, -1) + "\n";
      try {
        input += await rl.question(chalk.dim("· "));
      } catch {
        break;
      }
    }

    const trimmed = input.trim();
    if (!trimmed) continue;

    if (trimmed === "/exit" || trimmed === "/quit") break;

    if (trimmed === "/help") {
      console.log("");
      for (const c of commandDefs) {
        console.log(`  ${chalk.cyan(c.cmd.padEnd(12))} ${chalk.dim(c.desc)}`);
      }
      console.log(`  ${chalk.cyan("/quit".padEnd(12))} ${chalk.dim(t("cmd.quit_alias"))}`);
      if (skills.length > 0) {
        console.log(chalk.dim(`\n  ${t("repl.skills_header")}`));
        for (const s of skills) {
          const source = chalk.dim(`[${s.source === "project" ? t("repl.skill_source_project") : t("repl.skill_source_user")}]`);
          console.log(`  ${chalk.cyan(`/${s.name}`.padEnd(12))} ${chalk.dim(s.description || "")} ${source}`);
        }
      }
      console.log(`\n  ${chalk.dim(t("repl.ctrl_c"))}`);
      console.log(`  ${chalk.dim(t("repl.multiline"))}`);
      console.log(`  ${chalk.dim(t("repl.voice_hint"))}`);
      console.log(`  ${chalk.dim(t("repl.skills_hint"))}`);
      console.log("");
      continue;
    }

    if (trimmed === "/clear") {
      history.length = 0;
      try { writeFileSync(AUTOSAVE_FILE, "[]", "utf-8"); } catch { /* ignore */ }
      console.log(chalk.dim(`  ${t("repl.history_cleared")}`));
      continue;
    }

    if (trimmed === "/config") {
      voiceSettings = await doConfig(rl, client, voiceSettings);
      continue;
    }

    if (trimmed === "/tools") {
      const current = client.getToolsEnabled();
      client.setToolsEnabled(!current);
      const status = !current ? chalk.green(t("repl.tools_on")) : chalk.red(t("repl.tools_off"));
      console.log(chalk.dim(`  ${t("repl.tools_toggle", status)}`));
      continue;
    }

    if (trimmed === "/models") {
      await showModels(client, (ids) => { cachedModelIds = ids; });
      continue;
    }

    if (trimmed === "/model" || trimmed.startsWith("/model ")) {
      const newId = trimmed.slice(7).trim();
      if (!newId) {
        await showModels(client, (ids) => { cachedModelIds = ids; });
        continue;
      }
      client.setAgent(newId);
      try {
        const cfg = loadConfig();
        saveConfig({ ...cfg, agentId: newId });
      } catch { /* ignore */ }
      if (client.isAgentMode()) {
        console.log(chalk.dim(`  ${t("repl.set_agent", newId)}`));
      } else {
        console.log(chalk.dim(`  ${t("repl.set_model", newId)}`));
      }
      continue;
    }

    if (trimmed === "/save" || trimmed.startsWith("/save ")) {
      doSave(history, trimmed.slice(6).trim());
      continue;
    }

    if (trimmed === "/load") {
      const loaded = await doLoad(rl);
      if (loaded) {
        history.length = 0;
        history.push(...loaded);
        console.log(chalk.dim(`  ${t("repl.loaded", loaded.length)}`));
      }
      continue;
    }

    if (trimmed === "/mcp" || trimmed.startsWith("/mcp ")) {
      const arg = trimmed.slice(5).trim();
      const mcpStatus = mcp ? mcp.status() : [];

      if (!arg) {
        if (mcpStatus.length === 0) {
          console.log(chalk.dim(`  ${t("repl.no_mcp")}`));
          console.log(chalk.dim(`  ${t("repl.mcp_config_hint", join(CONFIG_DIR, "mcp.json"))}:`));
          console.log(chalk.dim(`  { "mcpServers": { "${t("repl.mcp_example_name")}": { "command": "...", "args": [...] } } }`));
        } else {
          console.log("");
          for (const s of mcpStatus) {
            if (s.error) {
              console.log(chalk.red(`  ✗ ${s.name}: ${s.error}`));
            } else {
              const icon = s.enabled ? chalk.green("✓") : chalk.yellow("○");
              const status = s.enabled ? "" : chalk.yellow(` (${t("repl.tools_off")})`);
              console.log(`  ${icon} ${s.name}${status}` + chalk.dim(` — ${s.tools} tools`));
            }
          }
          console.log(chalk.dim(`\n  ${t("repl.mcp_toggle_hint")}`));
        }
      } else if (mcp) {
        const parts = arg.split(/\s+/);
        const name = parts[0]!;
        const action = parts[1]?.toLowerCase();
        const server = mcpStatus.find((s) => s.name.toLowerCase() === name.toLowerCase());
        if (!server) {
          console.log(chalk.yellow(`  ${t("repl.mcp_unknown_server", name)}`));
        } else if (action === "on" || action === "off") {
          const wantEnabled = action === "on";
          const isEnabled = mcp.isServerEnabled(server.name);
          if (wantEnabled !== isEnabled) mcp.toggleServer(server.name);
          const label = wantEnabled ? chalk.green(t("repl.tools_on")) : chalk.red(t("repl.tools_off"));
          console.log(chalk.dim(`  ${server.name}: ${label}`));
        } else {
          const icon = server.enabled ? chalk.green("✓") : chalk.yellow("○");
          const status = server.enabled ? "" : chalk.yellow(` (${t("repl.tools_off")})`);
          console.log(`\n  ${icon} ${server.name}${status}` + chalk.dim(` — ${server.tools} tools`));
          if (!server.error) {
            for (const tn of server.toolNames) {
              const desc = tn.description ? chalk.dim(` — ${tn.description}`) : "";
              console.log(`    ${chalk.cyan(tn.name)}${desc}`);
            }
          }
          console.log("");
        }
      }
      continue;
    }

    if (trimmed === "/addons") {
      const allAddons = loadAddons();
      const active = detectAddons(allAddons, process.cwd());
      const activeNames = new Set(active.map((a) => a.name));
      if (allAddons.length === 0) {
        console.log(chalk.dim(`  ${t("repl.no_addons")}`));
      } else {
        console.log("");
        for (const a of allAddons) {
          const isActive = activeNames.has(a.name);
          const icon = isActive ? chalk.green("✓") : chalk.dim("○");
          const sourceLabel = a.source === "project" ? t("repl.skill_source_project") : a.source === "user" ? t("repl.skill_source_user") : "builtin";
          const desc = a.description ? chalk.dim(` — ${a.description}`) : "";
          const detect = chalk.dim(` [${a.detect.file}${a.detect.contains ? ` ⊃ ${a.detect.contains}` : ""}]`);
          console.log(`  ${icon} ${a.name}${desc} ${chalk.dim(`(${sourceLabel})`)}${detect}`);
        }
        console.log(chalk.dim(`\n  ${t("repl.addons_hint")}`));
      }
      continue;
    }

    if (trimmed === "/voice" || trimmed.startsWith("/voice ")) {
      voiceSettings = await doVoice(rl, trimmed.slice(6).trim(), voiceSettings);
      continue;
    }

    if (trimmed === "/restart") {
      console.log(chalk.dim(`  ${t("repl.restarting")}\n`));
      voice.dispose();
      await restartProcess(rl, async () => {
        if (mcp) await mcp.closeAll();
      });
      return;
    }

    if (trimmed === "/update") {
      const done = await doUpdate(rl, async () => {
        voice.dispose();
        if (mcp) await mcp.closeAll();
      });
      if (done) return;
      continue;
    }

    if (trimmed.startsWith("/")) {
      const slashName = trimmed.split(" ")[0]!.slice(1);
      const skillArgs = trimmed.slice(slashName.length + 2).trim();
      const skill = findSkill(skills, slashName);
      if (skill) {
        const rendered = renderSkill(skill, skillArgs);
        console.log(chalk.dim(`  ${t("repl.skill_invoked", skill.name)}`));
        const userItem: InputItem = { type: "message", role: "user", content: rendered };
        history.push(userItem);

        abortController = new AbortController();
        const ac = abortController;
        stdout.write("\n");
        const md = new MarkdownRenderer();
        spinner.start(t("repl.spinner_thinking"));

        await new Promise<void>((resolve) => {
          client
            .send(
              history,
              {
                onDelta: (text) => { spinner.stop(); stdout.write(md.write(text)); },
                onToolCall: (name, args) => {
                  spinner.stop(); stdout.write(md.flush());
                  const argsStr = Object.entries(args).map(([k, v]) => {
                    const val = typeof v === "string" && v.length > 80 ? v.slice(0, 77) + "..." : String(v);
                    return `${k}=${val}`;
                  }).join(", ");
                  stdout.write(chalk.dim(`\n  ⚡ ${name}(${argsStr})\n`));
                  spinner.start(t("repl.spinner_running"));
                },
                onToolResult: (name, result) => {
                  spinner.stop();
                  const lines = result.split("\n");
                  const preview = lines.length > 5 ? lines.slice(0, 5).join("\n") + `\n  ... (${t("repl.lines_total", lines.length)})` : result;
                  stdout.write(chalk.dim(`  ← ${name}: ${preview}\n\n`));
                  spinner.start(t("repl.spinner_thinking"));
                },
                onDone: (fullText) => {
                  spinner.stop(); stdout.write(md.flush());
                  if (fullText) history.push({ type: "message", role: "assistant", content: fullText });
                  autoSave(history);
                  stdout.write("\n\n");
                  abortController = null;
                  resolve();
                },
                onError: (error) => {
                  spinner.stop(); stdout.write(md.flush());
                  console.log(chalk.red(`\n  ${t("repl.error", formatError(error))}`));
                  history.pop();
                  abortController = null;
                  resolve();
                },
              },
              ac.signal,
            )
            .finally(() => { spinner.stop(); abortController = null; resolve(); });
        });
        continue;
      }
      console.log(chalk.yellow(`  ${t("repl.unknown_cmd", trimmed.split(" ")[0]!)}`));
      continue;
    }

    const userItem = trimmed.includes("@") ? buildMultiPartMessage(trimmed) : { type: "message" as const, role: "user" as const, content: trimmed };
    history.push(userItem);

    if (userItem.type === "message" && Array.isArray(userItem.content)) {
      for (const part of userItem.content) {
        if (part.type === "input_image") {
          const sizeKb = Math.round(part.image_url.length * 0.75 / 1024);
          stdout.write(chalk.dim(`  ${t("repl.image_attached", `${sizeKb} KB`)}\n`));
        } else if (part.type === "input_text" && part.text.includes("[File: ")) {
          const fileRefs = part.text.match(/\[File: ([^\]]+)\]/g);
          if (fileRefs) {
            for (const ref of fileRefs) {
              stdout.write(chalk.dim(`  ${t("repl.file_attached", ref.slice(7, -1))}\n`));
            }
          }
        }
      }
    }

    abortController = new AbortController();
    const ac = abortController;

    stdout.write("\n");
    const md = new MarkdownRenderer();
    spinner.start(t("repl.spinner_thinking"));

    await new Promise<void>((resolve) => {
      client
        .send(
          history,
          {
            onDelta: (text) => {
              spinner.stop();
              stdout.write(md.write(text));
            },
            onToolCall: (name, args) => {
              spinner.stop();
              stdout.write(md.flush());
              const argsStr = Object.entries(args)
                .map(([k, v]) => {
                  const val = typeof v === "string" && v.length > 80
                    ? v.slice(0, 77) + "..."
                    : String(v);
                  return `${k}=${val}`;
                })
                .join(", ");
              stdout.write(chalk.dim(`\n  ⚡ ${name}(${argsStr})\n`));
              spinner.start(t("repl.spinner_running"));
            },
            onToolResult: (name, result) => {
              spinner.stop();
              const lines = result.split("\n");
              const preview = lines.length > 5
                ? lines.slice(0, 5).join("\n") + `\n  ... (${t("repl.lines_total", lines.length)})`
                : result;
              stdout.write(chalk.dim(`  ← ${name}: ${preview}\n\n`));
              spinner.start(t("repl.spinner_thinking"));
            },
            onDone: (fullText) => {
              spinner.stop();
              stdout.write(md.flush());
              if (fullText) {
                history.push({ type: "message", role: "assistant", content: fullText });
              }
              autoSave(history);
              stdout.write("\n\n");
              abortController = null;
              checkForUpdate();
              resolve();
            },
            onError: (error) => {
              spinner.stop();
              stdout.write(md.flush());
              const msg = formatError(error);
              console.log(chalk.red(`\n  ${t("repl.error", msg)}`));
              history.pop();
              abortController = null;
              resolve();
            },
          },
          ac.signal,
        )
        .finally(() => {
          spinner.stop();
          abortController = null;
          resolve();
        });
    });
  }

  voice.dispose();
  rl.close();
  if (mcp) await mcp.closeAll();
  console.log(chalk.dim(`\n  ${t("repl.goodbye")}\n`));
}

async function doVoice(rl: readline.Interface, arg: string, current: VoiceSettings): Promise<VoiceSettings> {
  const settings = { ...current };
  const [sub, value] = arg.split(/\s+/, 2);

  if (!sub) {
    const status = settings.provider === "off"
      ? chalk.red(t("voice.off"))
      : chalk.green(PROVIDER_LABELS[settings.provider]);
    console.log(`  ${t("voice.status", status)}${chalk.dim(` · ${t("voice.language_label", settings.language)}`)}`);
    if (settings.provider !== "off") {
      console.log(chalk.dim(`  ${t("voice.hold_space")}`));
    }
    console.log(chalk.dim(`  ${t("voice.usage")}`));
    return settings;
  }

  if (sub === "nøgle" || sub === "key") {
    if (value !== "deepgram" && value !== "whisper") {
      console.log(chalk.yellow(`  ${t("voice.specify_key")}`));
      return settings;
    }
    const key = await askApiKey(rl, value);
    if (!key) {
      console.log(chalk.yellow(`  ${t("voice.no_key")}`));
      return current;
    }
    if (value === "deepgram") settings.deepgramApiKey = key;
    else settings.openaiApiKey = key;
    saveVoiceSettings(settings);
    const label = value === "deepgram" ? "Deepgram" : "OpenAI";
    console.log(chalk.green(`  ${t("voice.key_saved", label)}`));
    const envVar = value === "deepgram" ? "DEEPGRAM_API_KEY" : "OPENAI_API_KEY";
    if (process.env[envVar]) {
      console.log(chalk.yellow(`  ${t("voice.env_override", envVar)}`));
    }
    return settings;
  }

  if (sub === "off" || sub === "fra") {
    settings.provider = "off";
    saveVoiceSettings(settings);
    console.log(chalk.dim(`  ${t("voice.turned_off")}`));
    return settings;
  }

  if (sub === "sprog" || sub === "language") {
    if (!value) {
      console.log(chalk.yellow(`  ${t("voice.specify_lang")}`));
      return settings;
    }
    settings.language = value;
    saveVoiceSettings(settings);
    console.log(chalk.dim(`  ${t("voice.lang_set", value)}`));
    return settings;
  }

  if (sub !== "deepgram" && sub !== "whisper") {
    console.log(chalk.yellow(`  ${t("voice.unknown_option", sub)}`));
    return settings;
  }

  if (!apiKeyFor(settings, sub)) {
    const key = await askApiKey(rl, sub);
    if (!key) {
      console.log(chalk.yellow(`  ${t("voice.no_key_unchanged")}`));
      return current;
    }
    if (sub === "deepgram") settings.deepgramApiKey = key;
    else settings.openaiApiKey = key;
  }

  settings.provider = sub;
  saveVoiceSettings(settings);
  console.log(chalk.green(`  ${t("voice.status", PROVIDER_LABELS[sub])}`) + chalk.dim(` · ${t("voice.language_label", settings.language)}`));
  console.log(chalk.dim(`  ${t("voice.hold_space")}`));
  if (!findRecorder()) {
    console.log(chalk.yellow(`  ${t("voice.no_recorder", recorderInstallHint())}`));
  }
  return settings;
}

async function askApiKey(rl: readline.Interface, provider: "deepgram" | "whisper"): Promise<string> {
  const label = provider === "deepgram" ? "Deepgram" : "OpenAI";
  try {
    return (await rl.question(chalk.dim(`  ${t("voice.apikey_prompt", label)} `))).trim();
  } catch {
    return "";
  }
}

async function showModels(
  client: LibreChatClient,
  setCached: (ids: string[]) => void,
): Promise<void> {
  console.log(chalk.dim(`  ${t("repl.fetching_models")}`));
  try {
    const [agents, llmModels] = await Promise.all([
      client.listModels(),
      client.listLLMModels(),
    ]);
    const allIds = [...agents.map((m) => m.id), ...llmModels];
    setCached(allIds);

    if (agents.length === 0 && llmModels.length === 0) {
      console.log(chalk.yellow(`  ${t("repl.no_models")}`));
      return;
    }

    if (agents.length > 0) {
      console.log(chalk.dim(`\n  ${t("repl.agents_header")}`));
      for (const m of agents) {
        const label = m.name ? `${m.name} (${m.id})` : m.id;
        const active = m.id === client.getAgent() ? chalk.green(` ${t("repl.active")}`) : "";
        console.log(`    ${label}${active}`);
      }
    }

    if (llmModels.length > 0) {
      console.log(chalk.dim(`\n  ${t("repl.models_header")}`));
      for (const id of llmModels) {
        const active = id === client.getAgent() ? chalk.green(` ${t("repl.active")}`) : "";
        console.log(`    ${id}${active}`);
      }
    }

    console.log(chalk.dim(`\n  ${t("repl.model_tip")}`));
  } catch (err) {
    console.log(chalk.red(`  ${t("repl.error", err instanceof Error ? err.message : String(err))}`));
  }
}

async function doConfig(
  rl: readline.Interface,
  client: LibreChatClient,
  voiceSettings: VoiceSettings,
): Promise<VoiceSettings> {
  const voice = { ...voiceSettings };
  let cfg: { url: string; apiKey: string; advisorModel: string; language: string };
  try {
    const loaded = loadConfig();
    cfg = {
      url: loaded.url,
      apiKey: loaded.apiKey,
      advisorModel: client.getAdvisorModel() ?? loaded.advisorModel ?? "",
      language: loaded.language ?? getLocale(),
    };
  } catch {
    cfg = {
      url: process.env["LIBRECHAT_URL"] ?? "",
      apiKey: process.env["LIBRECHAT_API_KEY"] ?? "",
      advisorModel: client.getAdvisorModel() ?? "",
      language: getLocale(),
    };
  }

  let cachedAgents: Array<{ id: string; name?: string }> = [];
  try { cachedAgents = await client.listModels(); } catch { /* ignore */ }

  const mask = (s: string) => s ? s.slice(0, 3) + "***" + s.slice(-3) : "";
  const langName = (code: string) => code.startsWith("en") ? t("config.lang_en") : t("config.lang_da");
  const envHint = (envVar: string) => process.env[envVar] ? chalk.yellow(` (${t("config.env_override")})`) : "";

  const providerName = (p: VoiceSettings["provider"]) => p === "off" ? t("voice.off") : PROVIDER_LABELS[p];
  const keyShown = (key: string | undefined) => key ? mask(key) : t("config.not_set");

  const showMenu = () => {
    const row = (n: number, label: string, value: string, hint = "") =>
      console.log(`  ${chalk.cyan(`${n}.`)} ${label.padEnd(16)} ${chalk.dim(value)}${hint}`);
    console.log(`\n  ${chalk.bold(t("config.header"))}\n`);
    row(1, t("config.url"), cfg.url || t("config.not_set"), envHint("LIBRECHAT_URL"));
    row(2, t("config.apikey"), cfg.apiKey ? mask(cfg.apiKey) : t("config.not_set"), envHint("LIBRECHAT_API_KEY"));
    const advisorLabel = cfg.advisorModel
      ? (cachedAgents.find((a) => a.id === cfg.advisorModel)?.name ?? cfg.advisorModel)
      : t("config.not_set");
    row(3, t("config.advisor"), advisorLabel);
    row(4, t("config.language"), langName(cfg.language));
    row(5, t("config.voice_provider"), providerName(voice.provider));
    row(6, t("config.voice_language"), voice.language);
    row(7, t("config.keys_submenu"), "");
    console.log("");
  };

  try {
    while (true) {
      showMenu();
      const choice = (await rl.question(chalk.green(`  ${t("config.select", 7)} `))).trim();
      if (!choice) break;

      switch (choice) {
        case "1": {
          const val = (await rl.question(chalk.dim(`  ${t("config.url")} [${cfg.url || t("config.not_set")}]: `))).trim();
          if (val) cfg.url = val;
          break;
        }
        case "2": {
          const val = (await rl.question(chalk.dim(`  ${t("config.apikey")} [${cfg.apiKey ? mask(cfg.apiKey) : t("config.not_set")}]: `))).trim();
          if (val) cfg.apiKey = val;
          break;
        }
        case "3": {
          if (cachedAgents.length > 0) {
            console.log(`\n  ${t("config.advisor")}:`);
            for (let i = 0; i < cachedAgents.length; i++) {
              const a = cachedAgents[i]!;
              const label = a.name ? `${a.name} (${a.id})` : a.id;
              const active = a.id === cfg.advisorModel ? chalk.green(" ●") : "";
              console.log(`  ${chalk.cyan(`${i + 1}.`)} ${label}${active}`);
            }
            console.log("");
            const pick = (await rl.question(chalk.green(`  ${t("config.select", cachedAgents.length)} `))).trim();
            const idx = parseInt(pick, 10) - 1;
            const picked = cachedAgents[idx];
            if (picked) cfg.advisorModel = picked.id;
          } else {
            const val = (await rl.question(chalk.dim(`  ${t("config.advisor")} [${cfg.advisorModel || t("config.not_set")}]: `))).trim();
            if (val) cfg.advisorModel = val;
          }
          break;
        }
        case "4": {
          console.log(`\n  ${t("config.lang_select")}`);
          console.log(`  ${chalk.cyan("1.")} ${t("config.lang_da")}${cfg.language === "da" ? chalk.green(" ●") : ""}`);
          console.log(`  ${chalk.cyan("2.")} ${t("config.lang_en")}${cfg.language.startsWith("en") ? chalk.green(" ●") : ""}`);
          console.log("");
          const langChoice = (await rl.question(chalk.green(`  ${t("config.select", 2)} `))).trim();
          if (langChoice === "1") { cfg.language = "da"; setLocale("da"); }
          else if (langChoice === "2") { cfg.language = "en"; setLocale("en"); }
          break;
        }
        case "5": {
          const options = ["off", "deepgram", "whisper"] as const;
          console.log(`\n  ${t("config.voice_select")}`);
          options.forEach((p, i) => {
            console.log(`  ${chalk.cyan(`${i + 1}.`)} ${providerName(p)}${voice.provider === p ? chalk.green(" ●") : ""}`);
          });
          console.log("");
          const picked = options[Number((await rl.question(chalk.green(`  ${t("config.select", 3)} `))).trim()) - 1];
          if (!picked) break;
          if (picked !== "off" && !apiKeyFor(voice, picked)) {
            const key = await askApiKey(rl, picked);
            if (!key) {
              console.log(chalk.yellow(`  ${t("voice.no_key_unchanged")}`));
              break;
            }
            if (picked === "deepgram") voice.deepgramApiKey = key;
            else voice.openaiApiKey = key;
          }
          voice.provider = picked;
          break;
        }
        case "6": {
          const val = (await rl.question(chalk.dim(`  ${t("config.voice_language")} [${voice.language}]: `))).trim();
          if (val) voice.language = val;
          break;
        }
        case "7": {
          console.log(chalk.dim(`\n  ${t("config.keys_submenu")}`));
          console.log(`  ${chalk.cyan("1.")} Deepgram  ${chalk.dim(keyShown(voice.deepgramApiKey))}${envHint("DEEPGRAM_API_KEY")}`);
          console.log(`  ${chalk.cyan("2.")} OpenAI    ${chalk.dim(keyShown(voice.openaiApiKey))}${envHint("OPENAI_API_KEY")}`);
          console.log("");
          const keyChoice = (await rl.question(chalk.green(`  ${t("config.select", 2)} `))).trim();
          if (keyChoice === "1") {
            const val = (await rl.question(chalk.dim(`  ${t("config.deepgram_key")}: `))).trim();
            if (val) voice.deepgramApiKey = val;
          } else if (keyChoice === "2") {
            const val = (await rl.question(chalk.dim(`  ${t("config.openai_key")}: `))).trim();
            if (val) voice.openaiApiKey = val;
          }
          break;
        }
      }
    }

    saveConfig({ url: cfg.url, apiKey: cfg.apiKey, agentId: client.getAgent(), advisorModel: cfg.advisorModel || undefined, language: cfg.language });
    saveVoiceSettings(voice);
    client.setAdvisorModel(cfg.advisorModel || null);
    console.log(chalk.green(`  ${t("config.saved")}`));
    if (voice.provider !== "off" && !findRecorder()) {
      console.log(chalk.yellow(`  ${t("voice.no_recorder", recorderInstallHint())}`));
    }
    return voice;
  } catch {
    console.log(chalk.dim(`  ${t("config.cancelled")}`));
    return voiceSettings;
  }
}

function projectSlug(): string {
  return process.cwd().replace(/\//g, "-").replace(/^-/, "");
}
const PROJECT_DIR = join(CONFIG_DIR, "projects", projectSlug());
const CONV_DIR = join(PROJECT_DIR, "conversations");
const AUTOSAVE_FILE = join(PROJECT_DIR, "last_session.json");
const INPUT_HISTORY_FILE = join(CONFIG_DIR, "input_history.json");
const INPUT_HISTORY_SIZE = 500;

// Readline keeps history newest-first; the file uses the same order.
function loadInputHistory(): string[] {
  try {
    const lines = JSON.parse(readFileSync(INPUT_HISTORY_FILE, "utf-8")) as unknown;
    if (!Array.isArray(lines)) return [];
    return lines.filter((l): l is string => typeof l === "string").slice(0, INPUT_HISTORY_SIZE);
  } catch {
    return [];
  }
}

function saveInputHistory(lines: string[]): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(INPUT_HISTORY_FILE, JSON.stringify(lines.slice(0, INPUT_HISTORY_SIZE)), "utf-8");
  } catch { /* ignore */ }
}

interface SessionInfo {
  file: string;
  preview: string;
  msgCount: number;
  date: string;
  mtime: number;
}

function listSessions(): SessionInfo[] {
  const sessions: SessionInfo[] = [];

  // Autosave (last session)
  try {
    if (existsSync(AUTOSAVE_FILE)) {
      const items = JSON.parse(readFileSync(AUTOSAVE_FILE, "utf-8")) as InputItem[];
      if (Array.isArray(items) && items.length > 0) {
        const stat = statSync(AUTOSAVE_FILE);
        sessions.push(sessionInfoFrom(AUTOSAVE_FILE, items, stat.mtimeMs));
      }
    }
  } catch { /* ignore */ }

  // Saved conversations
  try {
    if (existsSync(CONV_DIR)) {
      const files = readdirSync(CONV_DIR).filter((f) => f.endsWith(".json"));
      for (const f of files) {
        const fullPath = join(CONV_DIR, f);
        try {
          const items = JSON.parse(readFileSync(fullPath, "utf-8")) as InputItem[];
          if (Array.isArray(items) && items.length > 0) {
            const stat = statSync(fullPath);
            sessions.push(sessionInfoFrom(fullPath, items, stat.mtimeMs));
          }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  sessions.sort((a, b) => b.mtime - a.mtime);

  // Deduplicate: if autosave matches a saved conversation's first message, keep only the newest
  const seen = new Set<string>();
  return sessions.filter((s) => {
    if (seen.has(s.preview)) return false;
    seen.add(s.preview);
    return true;
  }).slice(0, 9);
}

function sessionInfoFrom(file: string, items: InputItem[], mtimeMs: number): SessionInfo {
  const userMsgs = items.filter((m) => m.type === "message" && m.role === "user");
  const lastMsg = userMsgs[userMsgs.length - 1];
  const preview = lastMsg && lastMsg.type === "message" ? textOfContent(lastMsg.content).slice(0, 60).replace(/\n/g, " ") : "…";
  const date = new Date(mtimeMs).toLocaleDateString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return { file, preview, msgCount: userMsgs.length, date, mtime: mtimeMs };
}

function loadSessionFile(path: string): InputItem[] {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as InputItem[];
  } catch {
    return [];
  }
}

function autoSave(history: InputItem[]): void {
  try {
    if (history.length === 0) return;
    mkdirSync(PROJECT_DIR, { recursive: true });
    writeFileSync(AUTOSAVE_FILE, JSON.stringify(history, null, 2), "utf-8");
  } catch { /* ignore */ }
}

function autoLoad(): InputItem[] {
  try {
    if (!existsSync(AUTOSAVE_FILE)) return [];
    const raw = readFileSync(AUTOSAVE_FILE, "utf-8");
    const items = JSON.parse(raw) as InputItem[];
    if (!Array.isArray(items) || items.length === 0) return [];
    return items;
  } catch {
    return [];
  }
}

function doSave(history: InputItem[], name: string): void {
  if (history.length === 0) {
    console.log(chalk.yellow(`  ${t("repl.no_conversation")}`));
    return;
  }
  mkdirSync(CONV_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const slug = name || firstWords(history) || timestamp;
  const filename = `${slug}.json`;
  writeFileSync(join(CONV_DIR, filename), JSON.stringify(history, null, 2), "utf-8");
  console.log(chalk.dim(`  ${t("repl.saved_as", filename)}`));
}

function firstWords(history: InputItem[]): string {
  const first = history.find((m) => m.type === "message" && m.role === "user");
  if (!first || first.type !== "message") return "";
  const txt = textOfContent(first.content);
  return txt.slice(0, 40).replace(/[^a-zA-Z0-9æøåÆØÅ ]/g, "").trim().replace(/ +/g, "-").toLowerCase();
}

async function doLoad(rl: readline.Interface): Promise<InputItem[] | null> {
  try {
    const files = readdirSync(CONV_DIR).filter((f) => f.endsWith(".json")).sort().reverse();
    if (files.length === 0) {
      console.log(chalk.yellow(`  ${t("repl.no_saved")}`));
      return null;
    }
    console.log("");
    files.forEach((f, i) => {
      console.log(`  ${chalk.cyan(String(i + 1))}. ${f.replace(".json", "")}`);
    });
    console.log("");
    const answer = await rl.question(chalk.green(`  ${t("repl.select", files.length)} `));
    const idx = parseInt(answer.trim(), 10) - 1;
    const selected = files[idx];
    if (!selected) {
      console.log(chalk.yellow(`  ${t("repl.invalid_choice")}`));
      return null;
    }
    return JSON.parse(readFileSync(join(CONV_DIR, selected), "utf-8")) as InputItem[];
  } catch {
    console.log(chalk.yellow(`  ${t("repl.no_saved")}`));
    return null;
  }
}

async function doUpdate(rl: readline.Interface, onBeforeRestart?: () => Promise<void>): Promise<boolean> {
  const isDev = (process.argv[1] ?? "").endsWith(".ts");
  const thisFile = fileURLToPath(import.meta.url);
  const repoRoot = join(dirname(thisFile), "..");
  const exec = (cmd: string) => execSync(cmd, { cwd: repoRoot, encoding: "utf-8", stdio: "pipe" }).trim();

  let oldHead = "";
  try { oldHead = exec("git rev-parse HEAD"); } catch {}

  console.log(chalk.dim(`  ${t("repl.git_pull")}`));
  try {
    exec("git pull");
  } catch (err) {
    const msg = err instanceof Error ? (err as { stderr?: string }).stderr?.trim() || err.message : String(err);
    console.log(chalk.red(`  ${t("repl.git_pull_error", msg)}`));
    return false;
  }

  let newHead = "";
  try { newHead = exec("git rev-parse HEAD"); } catch {}

  if (oldHead === newHead) {
    console.log(chalk.dim(`  ${t("repl.already_updated")}`));
    return false;
  }

  try {
    const log = exec(`git log --reverse --format="%H|%s" ${oldHead}..${newHead}`);
    console.log("");
    for (const line of log.split("\n")) {
      if (!line) continue;
      const sep = line.indexOf("|");
      const hash = line.slice(0, sep);
      const msg = line.slice(sep + 1);
      let version = "";
      try {
        const pkg = exec(`git show ${hash}:package.json`);
        version = (JSON.parse(pkg) as { version: string }).version;
      } catch {}
      console.log(version ? `  ${chalk.cyan(`v${version}`)}  ${msg}` : `  ${msg}`);
    }
    console.log("");
  } catch {}

  if (!isDev) {
    console.log(chalk.dim(`  ${t("repl.npm_install")}`));
    try {
      exec("npm install");
    } catch (err) {
      const msg = err instanceof Error ? (err as { stderr?: string }).stderr?.trim() || err.message : String(err);
      console.log(chalk.red(`  ${t("repl.npm_install_error", msg)}`));
      return false;
    }

    console.log(chalk.dim(`  ${t("repl.npm_build")}`));
    try {
      exec("npm run build");
    } catch (err) {
      const msg = err instanceof Error ? (err as { stderr?: string }).stderr?.trim() || err.message : String(err);
      console.log(chalk.red(`  ${t("repl.build_error", msg)}`));
      return false;
    }
  }

  console.log(chalk.green(`  ${t("repl.updated")}\n`));
  await restartProcess(rl, onBeforeRestart);
  return true;
}

async function restartProcess(rl: readline.Interface, onBeforeRestart?: () => Promise<void>): Promise<void> {
  const isDev = (process.argv[1] ?? "").endsWith(".ts");
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  if (onBeforeRestart) await onBeforeRestart();
  rl.close();
  const { spawn } = await import("node:child_process");
  const entryPoint = join(repoRoot, isDev ? "src/index.ts" : "dist/index.js");
  const [cmd, args] = isDev
    ? ["npx", ["tsx", entryPoint]]
    : [process.argv[0]!, [entryPoint]];
  const child = spawn(cmd, args, { stdio: "inherit" });
  child.on("exit", (code: number | null) => process.exit(code ?? 0));
}

const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000;
let lastUpdateCheck = 0;

function checkForUpdate(): void {
  const now = Date.now();
  if (now - lastUpdateCheck < UPDATE_CHECK_INTERVAL) return;
  lastUpdateCheck = now;

  fetch("https://raw.githubusercontent.com/tvup/lcc/master/package.json")
    .then((res) => res.json())
    .then((remote: unknown) => {
      const remoteVersion = (remote as { version?: string }).version;
      if (!remoteVersion || remoteVersion === PKG.version) return;
      const [rMaj, rMin, rPatch] = remoteVersion.split(".").map(Number);
      const [lMaj, lMin, lPatch] = PKG.version.split(".").map(Number);
      if (rMaj! > lMaj! || (rMaj === lMaj && rMin! > lMin!) || (rMaj === lMaj && rMin === lMin && rPatch! > lPatch!)) {
        console.log(chalk.yellow(`\n  ${t("repl.update_available", remoteVersion, PKG.version)}\n`));
      }
    })
    .catch(() => {});
}

function formatError(error: Error): string {
  const msg = error.message;

  if (msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND")) {
    return t("err.connection");
  }
  if (msg.includes("Function tools with reasoning_effort")) {
    return t("err.reasoning");
  }

  if (msg.startsWith("HTTP ")) {
    const status = msg.slice(5, 8);
    const detail = msg.slice(10);
    switch (status) {
      case "401": return t("err.invalid_key", detail);
      case "403": return t("err.access_denied", detail) + (detail.includes("license") ? t("err.wakeforce") : "");
      case "404": return t("err.not_found", detail);
      case "429": return t("err.rate_limit");
      default: return msg;
    }
  }

  return msg;
}
