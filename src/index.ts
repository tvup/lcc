#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { loadConfig } from "./config.js";
import { LibreChatClient } from "./client.js";
import { McpManager, loadMcpConfig } from "./mcp.js";
import { startRepl } from "./repl.js";
import { t } from "./i18n.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as { version: string };

const arg = process.argv[2];
if (arg === "--version" || arg === "-v") {
  console.log(`lcc v${PKG.version}`);
  process.exit(0);
}
if (arg === "--help" || arg === "-h") {
  console.log(`
  ${chalk.bold("lcc")} v${PKG.version} — LibreChat Code

  ${chalk.dim(t("help.usage"))}
    lcc                       ${t("help.start_repl")}
    lcc --version, -v         ${t("help.show_version")}
    lcc --help, -h            ${t("help.show_help")}

  ${chalk.dim(t("help.env_vars"))}
    LIBRECHAT_URL             ${t("help.env_url")}
    LIBRECHAT_API_KEY         ${t("help.env_apikey")}
    LIBRECHAT_AGENT_ID        ${t("help.env_agent_id")}

  ${chalk.dim(t("help.or_configure"))}
    ~/.config/lcc/config.json
`);
  process.exit(0);
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(
      chalk.red(err instanceof Error ? err.message : String(err))
    );
    process.exit(1);
  }

  const client = new LibreChatClient(config, config.agentId ?? "");

  if (!config.agentId) {
    console.log(chalk.dim(`  ${t("startup.no_agent")}`));
    try {
      const models = await client.listModels();
      if (models.length === 0) {
        console.error(chalk.red(`  ${t("startup.no_models")}`));
        process.exit(1);
      }

      console.log(chalk.bold(`\n  ${t("startup.select_agent")}\n`));
      models.forEach((m, i) => {
        const label = m.name ? `${m.name} (${m.id})` : m.id;
        console.log(`  ${chalk.cyan(String(i + 1))}. ${label}`);
      });
      console.log();

      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(chalk.green(`  ${t("startup.select_prompt", models.length)} `));
      rl.close();

      const idx = parseInt(answer.trim(), 10) - 1;
      const selected = models[idx];
      if (!selected) {
        console.error(chalk.red(`  ${t("startup.invalid_choice")}`));
        process.exit(1);
      }

      client.setAgent(selected.id);
      console.log(chalk.dim(`\n  ${t("startup.selected", selected.name ?? selected.id)}`));
    } catch (err) {
      console.error(chalk.red(`  ${t("startup.fetch_error", err instanceof Error ? err.message : String(err))}`));
      console.error(chalk.dim(`  ${t("startup.set_manually")}`));
      process.exit(1);
    }
  }

  const mcpManager = new McpManager();
  const mcpConfig = loadMcpConfig();
  if (Object.keys(mcpConfig.mcpServers).length > 0) {
    console.log(chalk.dim(`  ${t("startup.connecting_mcp")}`));
    await mcpManager.connectAll(mcpConfig);
    const status = mcpManager.status();
    for (const s of status) {
      if (s.error) {
        console.log(chalk.red(`  ✗ ${s.name}: ${s.error}`));
      } else {
        console.log(chalk.dim(`  ✓ ${s.name} (${s.tools} tools)`));
      }
    }
  }

  client.setMcp(mcpManager);

  await startRepl(client, mcpManager);
}

main();
