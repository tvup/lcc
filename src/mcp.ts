import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { CONFIG_DIR } from "./config.js";
import type { ToolDef, ToolResult } from "./tools.js";
import { t } from "./i18n.js";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

interface ConnectedServer {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
  error?: string;
}

interface FailedServer {
  name: string;
  error: string;
}

const MCP_CONFIG_FILE = join(CONFIG_DIR, "mcp.json");
const MCP_STATE_FILE = join(CONFIG_DIR, "mcp-state.json");

function withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(msg)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function loadMcpConfig(): McpConfig {
  try {
    const raw = readFileSync(MCP_CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<McpConfig>;
    if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
      return { mcpServers: parsed.mcpServers };
    }
  } catch {
    // no config or invalid
  }
  return { mcpServers: {} };
}

function sanitizeToolName(serverName: string, toolName: string): string {
  const raw = `mcp__${serverName}__${toolName}`;
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

const ALLOWED_SCHEMA_KEYS = new Set([
  "type", "properties", "required", "items", "enum",
  "description", "default", "minimum", "maximum",
  "minLength", "maxLength", "pattern", "format",
  "minItems", "maxItems", "oneOf", "anyOf", "allOf",
  "not", "const", "title", "nullable",
]);

function cleanSchema(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(cleanSchema);

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (ALLOWED_SCHEMA_KEYS.has(key)) {
      cleaned[key] = cleanSchema(value);
    }
  }
  return cleaned;
}

export class McpManager {
  private servers: ConnectedServer[] = [];
  private failed: FailedServer[] = [];
  private toolMap = new Map<string, { server: ConnectedServer; originalName: string }>();
  private disabledServers = new Set<string>();

  private loadDisabledState(): void {
    try {
      const raw = readFileSync(MCP_STATE_FILE, "utf-8");
      const parsed = JSON.parse(raw) as { disabledServers?: string[] };
      if (Array.isArray(parsed.disabledServers)) {
        for (const name of parsed.disabledServers) {
          if (typeof name === "string") this.disabledServers.add(name);
        }
      }
    } catch { /* no state file yet */ }
  }

  private saveDisabledState(): void {
    try {
      mkdirSync(CONFIG_DIR, { recursive: true });
      writeFileSync(MCP_STATE_FILE, JSON.stringify({ disabledServers: [...this.disabledServers] }, null, 2) + "\n", "utf-8");
    } catch { /* best effort */ }
  }

  toggleServer(name: string): boolean {
    if (this.disabledServers.has(name)) {
      this.disabledServers.delete(name);
      this.saveDisabledState();
      return true;
    }
    this.disabledServers.add(name);
    this.saveDisabledState();
    return false;
  }

  isServerEnabled(name: string): boolean {
    return !this.disabledServers.has(name);
  }

  private activeServers(): ConnectedServer[] {
    return this.servers.filter((s) => !this.disabledServers.has(s.name));
  }

  async connectAll(config: McpConfig): Promise<void> {
    this.loadDisabledState();
    const entries = Object.entries(config.mcpServers);
    if (entries.length === 0) return;

    const CONNECT_TIMEOUT = 60_000;
    const defaultEnv = getDefaultEnvironment();

    const results = await Promise.allSettled(
      entries.map(async ([name, serverConfig]) => {
        const env = { ...defaultEnv, ...(serverConfig.env ?? {}) };

        const transport = new StdioClientTransport({
          command: serverConfig.command,
          args: serverConfig.args,
          env,
          stderr: "pipe",
        });

        let stderrTail = "";
        transport.stderr?.on("data", (chunk: Buffer) => {
          stderrTail = (stderrTail + chunk.toString()).slice(-2048);
        });

        const client = new Client({ name: "lcc", version: "1.0.0" });

        try {
          await withTimeout(client.connect(transport), CONNECT_TIMEOUT, t("mcp.timeout.startup"));

          const { tools } = await withTimeout(client.listTools(), CONNECT_TIMEOUT, t("mcp.timeout.list"));

          return {
            name,
            client,
            transport,
            tools: tools.map((item) => ({
              name: item.name,
              description: item.description,
              inputSchema: item.inputSchema as Record<string, unknown>,
            })),
          } satisfies ConnectedServer;
        } catch (err) {
          await client.close().catch(() => {});
          const msg = err instanceof Error ? err.message : String(err);
          const detail = stderrTail.trim();
          throw new Error(detail ? `${msg} (${detail.split("\n").pop()})` : msg);
        }
      }),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const name = entries[i]![0];

      if (result.status === "fulfilled") {
        const server = result.value;
        this.servers.push(server);

        for (const tool of server.tools) {
          const namespaced = sanitizeToolName(server.name, tool.name);
          this.toolMap.set(namespaced, { server, originalName: tool.name });
        }
      } else {
        const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.failed.push({ name, error });
      }
    }
  }

  getToolDefs(): ToolDef[] {
    const defs: ToolDef[] = [];

    for (const server of this.activeServers()) {
      for (const tool of server.tools) {
        const namespaced = sanitizeToolName(server.name, tool.name);
        const params = cleanSchema(tool.inputSchema) as Record<string, unknown>;
        if (!params["type"]) params["type"] = "object";
        if (!params["properties"]) params["properties"] = {};

        defs.push({
          type: "function",
          name: namespaced,
          description: tool.description ?? tool.name,
          parameters: params,
        });
      }
    }

    return defs;
  }

  hasTool(name: string): boolean {
    const entry = this.toolMap.get(name);
    if (!entry) return false;
    return !this.disabledServers.has(entry.server.name);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const entry = this.toolMap.get(name);
    if (!entry) {
      return { output: t("mcp.error.unknown", name), isError: true };
    }

    try {
      const result = await entry.server.client.callTool({
        name: entry.originalName,
        arguments: args,
      });

      const content = result.content as Array<Record<string, unknown>>;
      const parts: string[] = [];
      for (const item of content) {
        if (item["type"] === "text") {
          parts.push(String(item["text"] ?? ""));
        } else if (item["type"] === "image") {
          parts.push(t("mcp.image", String(item["mimeType"])));
        } else if (item["type"] === "resource") {
          const res = item["resource"] as Record<string, unknown> | undefined;
          if (res && "text" in res) {
            parts.push(String(res["text"]));
          } else {
            parts.push(t("mcp.resource", String(res?.["uri"] ?? "?")));
          }
        } else {
          parts.push(`[${item["type"]}]`);
        }
      }

      const output = parts.join("\n");
      if (result.isError) {
        return { output: t("mcp.error.prefix", output), isError: true };
      }
      return { output };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: t("mcp.error.call_failed", msg), isError: true };
    }
  }

  getServerNames(): string[] {
    return this.activeServers().map((s) => s.name);
  }

  allServerNames(): string[] {
    return this.servers.map((s) => s.name);
  }

  toolCount(): number {
    let count = 0;
    for (const s of this.activeServers()) count += s.tools.length;
    return count;
  }

  status(): Array<{ name: string; tools: number; toolNames: Array<{ name: string; description?: string }>; error?: string; enabled: boolean }> {
    const result: Array<{ name: string; tools: number; toolNames: Array<{ name: string; description?: string }>; error?: string; enabled: boolean }> = [];
    for (const s of this.servers) {
      result.push({
        name: s.name,
        tools: s.tools.length,
        toolNames: s.tools.map((item) => ({ name: item.name, description: item.description })),
        enabled: !this.disabledServers.has(s.name),
      });
    }
    for (const f of this.failed) {
      result.push({ name: f.name, tools: 0, toolNames: [], error: f.error, enabled: false });
    }
    return result;
  }

  mcpToolSummary(): string {
    const lines: string[] = [];
    for (const server of this.activeServers()) {
      const names = server.tools.map((item) => sanitizeToolName(server.name, item.name)).join(", ");
      lines.push(`${server.name}: ${names}`);
    }
    return lines.join("\n");
  }

  getToolCatalog(): Array<{ name: string; description: string }> {
    const catalog: Array<{ name: string; description: string }> = [];
    for (const server of this.activeServers()) {
      for (const tool of server.tools) {
        catalog.push({
          name: sanitizeToolName(server.name, tool.name),
          description: tool.description ?? tool.name,
        });
      }
    }
    return catalog;
  }

  getToolDefsByNames(names: Set<string>): ToolDef[] {
    const defs: ToolDef[] = [];
    for (const server of this.activeServers()) {
      for (const tool of server.tools) {
        const namespaced = sanitizeToolName(server.name, tool.name);
        if (!names.has(namespaced)) continue;
        const params = cleanSchema(tool.inputSchema) as Record<string, unknown>;
        if (!params["type"]) params["type"] = "object";
        if (!params["properties"]) params["properties"] = {};
        defs.push({
          type: "function",
          name: namespaced,
          description: tool.description ?? tool.name,
          parameters: params,
        });
      }
    }
    return defs;
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled(
      this.servers.map(async (server) => {
        try { await server.client.close(); } catch { /* ignore */ }
      }),
    );
    this.servers = [];
    this.failed = [];
    this.toolMap.clear();
  }
}
