import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { CONFIG_DIR } from "./config.js";

/**
 * Hook as defined in Claude Code plugin JSON format
 * https://docs.anthropic.com/en/docs/claude-code/hooks
 */
export interface PluginHookDefinition {
  matcher?: string;
  hooks: Array<{
    type: "command" | "command_substitution";
    command: string;
    async?: boolean;
  }>;
}

export interface PluginHookFile {
  hooks: Record<string, PluginHookDefinition[]>;
}

export interface Hook {
  name: string;
  description: string;
  body?: string;
  source: "claude" | "project" | "user";
  // Optional: path to the actual hook script/file
  path?: string;
  // For JSON plugin hooks, store the hook type (SessionEnd, PreToolUse, etc.)
  hookType?: string;
  // Indicates this is a Claude Code plugin hook
  isPluginHook?: boolean;
}

const CLAUDE_HOOKS_DIR = join(process.env.HOME || "", ".claude", "hooks");
const USER_HOOKS_DIR = join(CONFIG_DIR, "hooks");
const CLAUDE_PLUGINS_DIR = join(process.env.HOME || "", ".claude", "plugins");

/**
 * Check if a file is a JSON hook file (Claude Code plugin format)
 */
function isJsonHookFile(file: string): boolean {
  return file.endsWith(".json");
}

/**
 * Parse a JSON hook file (Claude Code plugin format)
 */
function parsePluginHookFile(filePath: string, source: Hook["source"]): Hook[] {
  const hooks: Hook[] = [];
  try {
    const raw = readFileSync(filePath, "utf-8").trim();
    if (!raw) return hooks;

    const json = JSON.parse(raw) as PluginHookFile;
    if (!json.hooks) return hooks;

    // Each key in json.hooks is a hook type (SessionEnd, PreToolUse, etc.)
    for (const [hookType, definitions] of Object.entries(json.hooks)) {
      for (const def of definitions) {
        for (const defHook of def.hooks) {
          const name = `plugin_${hookType}`;
          const hook: Hook = {
            name,
            description: `${hookType} hook via ${defHook.command}`,
            body: defHook.command,
            source,
            path: filePath,
            hookType,
            isPluginHook: true,
          };
          hooks.push(hook);
        }
      }
    }
  } catch {
    // ignore JSON parse errors
  }
  return hooks;
}

/**
 * Parse a hook file and extract metadata
 * Claude Code hooks are shell scripts with a header block
 */
function parseHookFile(filePath: string, source: Hook["source"]): Hook | null {
  try {
    const raw = readFileSync(filePath, "utf-8").trim();
    if (!raw) return null;

    const lines = raw.split("\n");
    const fileName = basename(filePath);
    let name = fileName;
    let description = "";
    
    // Try to extract name/description from header comments
    // Claude hooks often have "# Hook: name" or similar in first few lines
    for (let i = 0; i < Math.min(lines.length, 5); i++) {
      const line = lines[i]!.trim();
      if (!line) continue;
      if (line.startsWith("# ")) {
        description = line.slice(2).trim();
        break;
      }
      if (line.startsWith("# Hook:")) {
        name = line.replace("# Hook:", "").trim();
        break;
      }
    }

    // Extract body (everything after header comments)
    const bodyStart = lines.findIndex(line => line.trim() && !line.startsWith("#"));
    const body = bodyStart >= 0 ? lines.slice(bodyStart).join("\n").trim() : undefined;

    return { name, description, body, source };
  } catch {
    return null;
  }
}

/**
 * Load hooks from Claude Code's default location (~/.claude/hooks/)
 */
export function loadClaudeHooks(): Hook[] {
  const hooks: Hook[] = [];
  const seen = new Set<string>();

  if (!existsSync(CLAUDE_HOOKS_DIR)) {
    return hooks;
  }

  try {
    for (const file of readdirSync(CLAUDE_HOOKS_DIR)) {
      if (!file.endsWith(".sh") && !file.endsWith(".bash") && !file.endsWith(".ts")) continue;
      const filePath = join(CLAUDE_HOOKS_DIR, file);
      const hook = parseHookFile(filePath, "claude");
      if (hook && !seen.has(hook.name)) {
        hooks.push(hook);
        seen.add(hook.name);
      }
    }
  } catch { /* ignore */ }

  return hooks;
}

/**
 * Load hooks from project-level .lcc/hooks/ directory
 */
export function loadProjectHooks(): Hook[] {
  const hooks: Hook[] = [];
  const seen = new Set<string>();
  const projDir = join(process.cwd(), ".lcc", "hooks");

  if (!existsSync(projDir)) {
    return hooks;
  }

  try {
    for (const file of readdirSync(projDir)) {
      if (!file.endsWith(".sh") && !file.endsWith(".bash") && !file.endsWith(".ts")) continue;
      const filePath = join(projDir, file);
      const hook = parseHookFile(filePath, "project");
      if (hook && !seen.has(hook.name)) {
        hooks.push(hook);
        seen.add(hook.name);
      }
    }
  } catch { /* ignore */ }

  return hooks;
}

/**
 * Load hooks from user-level CONFIG_DIR/hooks/
 */
export function loadUserHooks(): Hook[] {
  const hooks: Hook[] = [];
  const seen = new Set<string>();

  if (!existsSync(USER_HOOKS_DIR)) {
    return hooks;
  }

  try {
    for (const file of readdirSync(USER_HOOKS_DIR)) {
      if (!file.endsWith(".sh") && !file.endsWith(".bash") && !file.endsWith(".ts")) continue;
      const filePath = join(USER_HOOKS_DIR, file);
      const hook = parseHookFile(filePath, "user");
      if (hook && !seen.has(hook.name)) {
        hooks.push(hook);
      }
    }
  } catch { /* ignore */ }

  return hooks;
}

/**
 * Load all hooks in priority order:
 * 1. Claude Code global hooks (~/.claude/hooks/) - highest priority
 * 2. Project-level hooks (.lcc/hooks/)
 * 3. User-level hooks (CONFIG_DIR/hooks/)
 * Later sources can override earlier ones (by name)
 */
export function loadAllHooks(): Hook[] {
  const all: Hook[] = [];

  // Claude Code hooks first (highest priority - they come from the integration)
  all.push(...loadClaudeHooks());
  
  // Project-level hooks
  all.push(...loadProjectHooks());
  
  // User-level hooks
  all.push(...loadUserHooks());

  // Deduplicate by name, keeping first occurrence (Claude > Project > User)
  const seen = new Set<string>();
  const deduped: Hook[] = [];
  for (const hook of all) {
    if (!seen.has(hook.name)) {
      seen.add(hook.name);
      deduped.push(hook);
    }
  }

  return deduped;
}

export function findHook(hooks: Hook[], name: string): Hook | undefined {
  return hooks.find((s) => s.name === name);
}

export function renderHook(hook: Hook, args: string): string {
  if (!hook.body) return "";
  return hook.body.replace(/\$ARGUMENTS/g, args);
}
