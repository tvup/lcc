import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { t, setLocale } from "./i18n.js";

export interface Config {
  url: string;
  apiKey: string;
  agentId?: string;
  advisorModel?: string;
  language?: string;
  plugins?: Record<string, { path?: string; version?: string; installed: boolean; type?: "lcc" | "claude" }>;
  showPromptFinishAlert?: boolean;
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
    return { url, apiKey, agentId, advisorModel: fileConfig.advisorModel, language, plugins: fileConfig.plugins, showPromptFinishAlert: fileConfig.showPromptFinishAlert };
  }

  if (fileConfig.url && fileConfig.apiKey) {
    return {
      url: fileConfig.url,
      apiKey: fileConfig.apiKey,
      agentId: agentId ?? fileConfig.agentId,
      advisorModel: fileConfig.advisorModel,
      language,
      plugins: fileConfig.plugins,
    };
  }

  throw new Error(t("config.missing", CONFIG_FILE));
}

export function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", "utf-8");
  chmodSync(CONFIG_FILE, 0o600);
}

export function loadPlugins(): Record<string, { path?: string; version?: string; installed: boolean; type?: "lcc" | "claude" }> {
  const cfg = loadConfig();
  const lccPlugins = cfg.plugins ?? {};
  
  // Also load Claude Code plugins from ~/.claude/plugins/
  const claudePluginsDir = join(process.env["HOME"] || "", ".claude", "plugins");
  const claudePlugins = loadClaudePlugins(claudePluginsDir);
  
  // Merge both, Claude plugins get type: "claude"
  const merged: Record<string, { path?: string; version?: string; installed: boolean; type?: "lcc" | "claude" }> = { ...lccPlugins };
  
  for (const [name, info] of Object.entries(claudePlugins)) {
    if (!merged[name]) {
      merged[name] = { ...info, type: "claude" };
    }
  }
  
  return merged;
}

export function loadClaudePlugins(pluginsDir: string): Record<string, { path: string; version: string; installed: boolean; name?: string }> {
  const result: Record<string, { path: string; version: string; installed: boolean; name?: string }> = {};
  
  if (!existsSync(pluginsDir)) return result;
  
  const entries = readdirSync(pluginsDir, { withFileTypes: true });
  
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const pluginPath = join(pluginsDir, entry.name);
      const pluginJsonPath = join(pluginPath, ".claude-plugin", "plugin.json");
      
      // Check if plugin has valid structure with .claude-plugin/plugin.json
      if (existsSync(pluginJsonPath)) {
        // Read plugin name and version from plugin.json
        let name = entry.name;
        let version = "unknown";
        
        try {
          const pkg = JSON.parse(readFileSync(pluginJsonPath, "utf-8"));
          name = pkg.name || entry.name;
          version = pkg.version || "unknown";
        } catch {}
        
        result[name] = {
          path: pluginPath,
          version,
          installed: true,
          name,
        };
      }
    }
  }
  
  return result;
}

export function savePlugins(plugins: Record<string, { path?: string; version?: string; installed: boolean }>): void {
  const cfg = loadConfig();
  cfg.plugins = plugins;
  saveConfig(cfg);
}

export function ensurePluginDir(): void {
  mkdirSync(PLUGIN_DIR, { recursive: true });
}
