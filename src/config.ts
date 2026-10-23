import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { t, setLocale } from "./i18n.js";

export interface Config {
  url: string;
  apiKey: string;
  agentId?: string;
  advisorModel?: string;
  language?: string;
  plugins?: Record<string, { path?: string; version?: string; installed: boolean }>;
}

export const CONFIG_DIR = join(homedir(), ".config", "lcc");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const PLUGIN_DIR = join(CONFIG_DIR, "plugins");

export function loadConfig(): Config {
  const url = process.env["LIBRECHAT_URL"];
  const apiKey = process.env["LIBRECHAT_API_KEY"];
  const agentId = process.env["LIBRECHAT_AGENT_ID"];

  let fileConfig: Partial<Config> = {};
  try {
    fileConfig = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Partial<Config>;
  } catch { /* config file doesn't exist or is invalid */ }

  const language = fileConfig.language;
  if (language && !process.env["LCC_LANG"]) setLocale(language);

  if (url && apiKey) {
    return { url, apiKey, agentId, advisorModel: fileConfig.advisorModel, language };
  }

  if (fileConfig.url && fileConfig.apiKey) {
    return {
      url: fileConfig.url,
      apiKey: fileConfig.apiKey,
      agentId: agentId ?? fileConfig.agentId,
      advisorModel: fileConfig.advisorModel,
      language,
    };
  }

  throw new Error(t("config.missing", CONFIG_FILE));
}

export function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
  chmodSync(CONFIG_FILE, 0o600);
}

export function loadPlugins(): Record<string, { path?: string; version?: string; installed: boolean }> {
  const cfg = loadConfig();
  return cfg.plugins ?? {};
}

export function savePlugins(plugins: Record<string, { path?: string; version?: string; installed: boolean }>): void {
  const cfg = loadConfig();
  cfg.plugins = plugins;
  saveConfig(cfg);
}

export function ensurePluginDir(): void {
  mkdirSync(PLUGIN_DIR, { recursive: true });
}
