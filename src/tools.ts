import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { t } from "./i18n.js";

export interface ToolDef {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolResult {
  output: string;
  truncated?: boolean;
  isError?: boolean;
}

const MAX_OUTPUT = 12_000;

function truncate(text: string): { output: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT) return { output: text, truncated: false };
  return {
    output: text.slice(0, MAX_OUTPUT) + `\n\n${t("tool.truncated")}`,
    truncated: true,
  };
}

export const toolDefinitions: ToolDef[] = [
  {
    type: "function",
    name: "read_file",
    description:
      "Read a file. Returns contents with line numbers. Use relative paths from the project root.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (relative to project root)" },
        offset: {
          type: "integer",
          description: "Line number to start reading from (0-based). Optional.",
        },
        limit: {
          type: "integer",
          description: "Max number of lines to read. Optional.",
        },
      },
      required: ["path"],
    },
  },
  {
    type: "function",
    name: "write_file",
    description:
      "Write content to a file, creating or overwriting. Creates parent dirs as needed.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (relative to project root)" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    type: "function",
    name: "edit_file",
    description:
      "Replace an exact string in a file. old_string must match exactly. Use write_file for new files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (relative to project root)" },
        old_string: { type: "string", description: "Exact text to find" },
        new_string: { type: "string", description: "Text to replace it with" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    type: "function",
    name: "bash",
    description:
      "Run a bash command. Working dir is the project root. 30s timeout.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command to run" },
      },
      required: ["command"],
    },
  },
  {
    type: "function",
    name: "grep",
    description:
      "Search for a regex pattern in files recursively. Returns matching lines.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Regex pattern to search for",
        },
        path: {
          type: "string",
          description: "Directory or file to search in. Defaults to current directory.",
        },
        include: {
          type: "string",
          description: "Glob pattern for files to include, e.g. '*.ts'",
        },
      },
      required: ["pattern"],
    },
  },
  {
    type: "function",
    name: "list_files",
    description:
      "List files and directories. Only for discovering structure, not reading content.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path to list. Defaults to current directory.",
        },
        recursive: {
          type: "boolean",
          description: "List recursively (max depth 3). Default false.",
        },
      },
      required: [],
    },
  },
];

export function executeTool(
  name: string,
  args: Record<string, unknown>,
): ToolResult {
  switch (name) {
    case "read_file":
      return execReadFile(args);
    case "write_file":
      return execWriteFile(args);
    case "edit_file":
      return execEditFile(args);
    case "bash":
      return execBash(args);
    case "grep":
      return execGrep(args);
    case "list_files":
      return execListFiles(args);
    default:
      return { output: t("tool.error.unknown", name), isError: true };
  }
}

function resolvePath(path: string): string {
  const resolved = resolve(path);
  if (existsSync(resolved)) return resolved;
  if (path.startsWith("/")) {
    const relative = resolve(path.slice(1));
    if (existsSync(relative)) return relative;
  }
  return resolved;
}

function execReadFile(args: Record<string, unknown>): ToolResult {
  const path = String(args["path"] ?? "");
  if (!path) return { output: t("tool.error.path_required"), isError: true };

  try {
    const resolved = resolvePath(path);
    if (!existsSync(resolved)) {
      return { output: t("tool.error.file_not_found", resolved), isError: true };
    }

    const stat = statSync(resolved);
    if (stat.isDirectory()) {
      return { output: t("tool.error.is_directory", resolved), isError: true };
    }

    let content = readFileSync(resolved, "utf-8");
    const lines = content.split("\n");
    const offset = typeof args["offset"] === "number" ? args["offset"] : 0;
    const defaultLimit = 200;
    const limit =
      typeof args["limit"] === "number" ? args["limit"] : defaultLimit;
    const hasMore = offset + limit < lines.length;

    const selected = lines.slice(offset, offset + limit);
    content = selected
      .map((line, i) => `${offset + i + 1}\t${line}`)
      .join("\n");

    if (hasMore) {
      content += `\n\n${t("tool.lines_hint", lines.length, offset + 1, offset + selected.length, offset + limit)}`;
    }

    return truncate(content);
  } catch (err) {
    return {
      output: t("tool.error.read_failed", err instanceof Error ? err.message : String(err)),
      isError: true,
    };
  }
}

function execWriteFile(args: Record<string, unknown>): ToolResult {
  const path = String(args["path"] ?? "");
  const content = String(args["content"] ?? "");
  if (!path) return { output: t("tool.error.path_required"), isError: true };

  try {
    const resolved = resolvePath(path);
    const dir = dirname(resolved);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(resolved, content, "utf-8");
    return { output: t("tool.file_written", resolved, content.length) };
  } catch (err) {
    return {
      output: t("tool.error.write_failed", err instanceof Error ? err.message : String(err)),
      isError: true,
    };
  }
}

function execEditFile(args: Record<string, unknown>): ToolResult {
  const path = String(args["path"] ?? "");
  const oldStr = String(args["old_string"] ?? "");
  const newStr = String(args["new_string"] ?? "");
  if (!path) return { output: t("tool.error.path_required"), isError: true };
  if (!oldStr) return { output: t("tool.error.old_string_required"), isError: true };

  try {
    const resolved = resolvePath(path);
    if (!existsSync(resolved)) {
      return { output: t("tool.error.file_not_found", resolved), isError: true };
    }

    const content = readFileSync(resolved, "utf-8");
    const count = content.split(oldStr).length - 1;

    if (count === 0) {
      return { output: t("tool.error.not_found_in_file"), isError: true };
    }
    if (count > 1) {
      return {
        output: t("tool.error.multiple_matches", count),
        isError: true,
      };
    }

    const updated = content.replace(oldStr, newStr);
    writeFileSync(resolved, updated, "utf-8");
    return { output: t("tool.file_edited", resolved) };
  } catch (err) {
    return {
      output: t("tool.error.edit_failed", err instanceof Error ? err.message : String(err)),
      isError: true,
    };
  }
}

function execBash(args: Record<string, unknown>): ToolResult {
  const command = String(args["command"] ?? "");
  if (!command) return { output: t("tool.error.command_required"), isError: true };

  try {
    const output = execSync(command, {
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 1024 * 1024,
    });
    return truncate(output);
  } catch (err) {
    const execErr = err as {
      stdout?: string;
      stderr?: string;
      status?: number;
      message: string;
    };
    const output = [execErr.stdout, execErr.stderr].filter(Boolean).join("\n");
    const exitCode = execErr.status ?? "?";
    return truncate(`Exit code: ${exitCode}\n${output || execErr.message}`);
  }
}

function execGrep(args: Record<string, unknown>): ToolResult {
  const pattern = String(args["pattern"] ?? "");
  if (!pattern) return { output: t("tool.error.pattern_required"), isError: true };

  const searchPath = String(args["path"] ?? ".");
  const include = args["include"] ? `--include=${JSON.stringify(String(args["include"]))}` : "";

  try {
    const cmd = `grep -rn ${include} -E ${JSON.stringify(pattern)} ${JSON.stringify(searchPath)} 2>/dev/null | head -100`;
    const output = execSync(cmd, {
      encoding: "utf-8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    if (!output.trim()) return { output: t("tool.no_results") };
    return truncate(output);
  } catch {
    return { output: t("tool.no_results") };
  }
}

function execListFiles(args: Record<string, unknown>): ToolResult {
  const searchPath = String(args["path"] ?? ".");
  const recursive = args["recursive"] === true;

  try {
    const depth = recursive ? "-maxdepth 3" : "-maxdepth 1";
    const cmd = `find ${JSON.stringify(searchPath)} ${depth} -not -path '*/node_modules/*' -not -path '*/.git/*' | sort | head -200`;
    const output = execSync(cmd, {
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return truncate(output);
  } catch (err) {
    return {
      output: t("tool.error_prefix") + `: ${err instanceof Error ? err.message : err}`,
      isError: true,
    };
  }
}
