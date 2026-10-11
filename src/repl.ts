import * as readline from "node:readline/promises";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { stdin, stdout } from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { LibreChatClient, type InputItem } from "./client.js";
import { loadConfig, saveConfig, CONFIG_DIR } from "./config.js";
import { MarkdownRenderer } from "./markdown.js";
import type { McpManager } from "./mcp.js";
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
    { cmd: "/update", desc: t("cmd.update") },
    { cmd: "/restart", desc: t("cmd.restart") },
    { cmd: "/voice", desc: t("cmd.voice") },
    { cmd: "/exit", desc: t("cmd.exit") },
  ];
  const commands = [...commandDefs.map((c) => c.cmd), "/quit"];
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

  function cursorCol(): number {
    return 3 + ((rl as unknown as { cursor: number }).cursor ?? 0);
  }

  function clearHints(): void {
    if (hintLines === 0) return;
    for (let i = 0; i < hintLines; i++) {
      stdout.write("\n\x1b[2K");
    }
    stdout.write(`\x1b[${hintLines}A\x1b[${cursorCol()}G`);
    hintLines = 0;
  }

  function showHints(line: string): void {
    clearHints();
    if (!line.startsWith("/")) return;

    let hints: Array<{ label: string; desc: string }> = [];

    if (line.startsWith("/model ")) {
      const partial = line.slice(7);
      if (partial) {
        hints = cachedModelIds
          .filter((id) => id.startsWith(partial))
          .slice(0, 6)
          .map((id) => ({ label: `/model ${id}`, desc: "" }));
      }
    } else {
      hints = commandDefs
        .filter((c) => c.cmd.startsWith(line))
        .map((c) => ({ label: c.cmd, desc: c.desc }));
    }

    if (hints.length === 0) return;

    // A hint that wraps leaves a row behind that clearHints() cannot reach.
    const width = (stdout.columns || 80) - 1;
    for (const h of hints) {
      const matchLen = line.length;
      const label = h.label.slice(0, Math.max(0, width - 3));
      const room = width - 3 - label.length - 2;
      let desc = h.desc;
      if (desc.length > room) desc = room > 1 ? desc.slice(0, room - 1) + "…" : "";
      const highlighted =
        chalk.dim("   ") +
        chalk.bold.white(label.slice(0, matchLen)) +
        chalk.cyan(label.slice(matchLen)) +
        (desc ? chalk.dim(`  ${desc}`) : "");
      stdout.write(`\n\x1b[2K${highlighted}`);
    }
    hintLines = hints.length;
    stdout.write(`\x1b[${hintLines}A\x1b[${cursorCol()}G`);
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
  const toolLine = client.isAgentMode()
    ? chalk.dim(`   Tools: ${client.getToolsEnabled() ? chalk.green(t("repl.tools_on_short")) : chalk.red(t("repl.tools_off_short"))}`)
    : chalk.dim("   Tools: —");
  const mcpCount = mcp?.toolCount() ?? 0;
  const mcpLine = mcpCount > 0
    ? chalk.dim(`   MCP: ${mcp!.getServerNames().length} ${mcp!.getServerNames().length > 1 ? t("repl.server_many") : t("repl.server_one")}, ${mcpCount} tools`)
    : "";
  console.log(
    "\n" +
    chalk.cyan("    /\\_/\\") + "   " + chalk.bold.cyan("lcc") + chalk.dim(` v${PKG.version} — LibreChat Code`) + "\n" +
    chalk.cyan("   ( ● ● )") + chalk.dim(`  ${modeLabel}: ${agent}`) + "\n" +
    chalk.cyan("    > ▽ <") + toolLine + "\n" +
    chalk.cyan("   /|   |\\") + (mcpLine || chalk.dim(`  ${t("repl.help_commands")}`)) + "\n" +
    chalk.cyan("  (_|   |_)") + (mcpLine ? chalk.dim(`  ${t("repl.help_commands")}`) : "") + "\n"
  );

  const previousSession = autoLoad();
  if (previousSession.length > 0) {
    const msgCount = previousSession.filter((m) => m.type === "message" && m.role === "user").length;
    const lastMsg = previousSession.filter((m) => m.type === "message" && m.role === "user").pop();
    const preview = lastMsg && lastMsg.type === "message" ? lastMsg.content.slice(0, 60) : "";
    console.log(chalk.dim(`  ${t("repl.prev_session", msgCount, `${preview}${preview.length >= 60 ? "..." : ""}`)}`));
    try {
      const answer = await rl.question(chalk.dim(`  ${t("repl.continue_prompt")} (${confirmHint()}) `));
      if (confirmYes(answer)) {
        history.push(...previousSession);
        console.log(chalk.dim(`  ${t("repl.messages_loaded", previousSession.length)}\n`));
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
      console.log(`\n  ${chalk.dim(t("repl.ctrl_c"))}`);
      console.log(`  ${chalk.dim(t("repl.multiline"))}`);
      console.log(`  ${chalk.dim(t("repl.voice_hint"))}`);
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

    if (trimmed === "/mcp") {
      const mcpStatus = mcp ? mcp.status() : [];
      if (mcpStatus.length === 0) {
        console.log(chalk.dim(`  ${t("repl.no_mcp")}`));
        console.log(chalk.dim(`  ${t("repl.mcp_config_hint", join(CONFIG_DIR, "mcp.json"))}:`));
        console.log(chalk.dim(`  { "mcpServers": { "${t("repl.mcp_example_name")}": { "command": "...", "args": [...] } } }`));
      } else {
        for (const s of mcpStatus) {
          if (s.error) {
            console.log(chalk.red(`  ✗ ${s.name}: ${s.error}`));
          } else {
            console.log(chalk.green(`  ✓ ${s.name}`) + chalk.dim(` (${s.tools} tools)`));
            for (const tn of s.toolNames) {
              const desc = tn.description ? chalk.dim(` — ${tn.description}`) : "";
              console.log(`    ${chalk.cyan(tn.name)}${desc}`);
            }
          }
        }
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
      console.log(chalk.yellow(`  ${t("repl.unknown_cmd", trimmed.split(" ")[0]!)}`));
      continue;
    }

    history.push({ type: "message", role: "user", content: trimmed });

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
    const models = await client.listModels();
    setCached(models.map((m) => m.id));
    if (models.length === 0) {
      console.log(chalk.yellow(`  ${t("repl.no_models")}`));
    } else {
      console.log(chalk.dim(`  ${t("repl.agents_header")}`));
      for (const m of models) {
        const label = m.name ? `${m.name} (${m.id})` : m.id;
        const active = m.id === client.getAgent() ? chalk.green(` ${t("repl.active")}`) : "";
        console.log(`    ${label}${active}`);
      }
      console.log(chalk.dim(`\n  ${t("repl.model_tip")}`));
    }
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
  let cfg: { url: string; apiKey: string; agentId: string; language: string };
  try {
    const loaded = loadConfig();
    cfg = {
      url: loaded.url,
      apiKey: loaded.apiKey,
      agentId: loaded.agentId ?? client.getAgent(),
      language: loaded.language ?? getLocale(),
    };
  } catch {
    cfg = {
      url: process.env["LIBRECHAT_URL"] ?? "",
      apiKey: process.env["LIBRECHAT_API_KEY"] ?? "",
      agentId: client.getAgent(),
      language: getLocale(),
    };
  }

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
    row(3, t("config.agent_id"), cfg.agentId || t("config.not_set"));
    row(4, t("config.language"), langName(cfg.language));
    row(5, t("config.voice_provider"), providerName(voice.provider));
    row(6, t("config.voice_language"), voice.language);
    row(7, t("config.deepgram_key"), keyShown(voice.deepgramApiKey), envHint("DEEPGRAM_API_KEY"));
    row(8, t("config.openai_key"), keyShown(voice.openaiApiKey), envHint("OPENAI_API_KEY"));
    console.log("");
  };

  try {
    while (true) {
      showMenu();
      const choice = (await rl.question(chalk.green(`  ${t("config.select", 8)} `))).trim();
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
          const val = (await rl.question(chalk.dim(`  ${t("config.agent_id")} [${cfg.agentId || t("config.not_set")}]: `))).trim();
          if (val) cfg.agentId = val;
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
          const val = (await rl.question(chalk.dim(`  ${t("config.deepgram_key")} [${keyShown(voice.deepgramApiKey)}]: `))).trim();
          if (val) voice.deepgramApiKey = val;
          break;
        }
        case "8": {
          const val = (await rl.question(chalk.dim(`  ${t("config.openai_key")} [${keyShown(voice.openaiApiKey)}]: `))).trim();
          if (val) voice.openaiApiKey = val;
          break;
        }
      }
    }

    saveConfig({ url: cfg.url, apiKey: cfg.apiKey, agentId: cfg.agentId || undefined, language: cfg.language });
    saveVoiceSettings(voice);
    client.setAgent(cfg.agentId);
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

const CONV_DIR = join(CONFIG_DIR, "conversations");
const AUTOSAVE_FILE = join(CONFIG_DIR, "last_session.json");
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

function autoSave(history: InputItem[]): void {
  try {
    if (history.length === 0) return;
    mkdirSync(CONFIG_DIR, { recursive: true });
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
  return first.content.slice(0, 40).replace(/[^a-zA-Z0-9æøåÆØÅ ]/g, "").trim().replace(/ +/g, "-").toLowerCase();
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
