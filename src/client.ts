import { readdirSync } from "node:fs";
import type { Config } from "./config.js";
import { toolDefinitions, executeTool, type ToolDef } from "./tools.js";
import type { McpManager } from "./mcp.js";
import { t } from "./i18n.js";

export type ContentPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string };

export type InputItem =
  | { type: "message"; role: "user" | "assistant"; content: string | ContentPart[] }
  | {
      type: "function_call";
      id: string;
      call_id: string;
      name: string;
      arguments: string;
      status: "completed";
    }
  | { type: "function_call_output"; call_id: string; output: string };

interface StreamedFunctionCall {
  id: string;
  call_id: string;
  name: string;
  arguments: string;
}

export interface StreamCallbacks {
  onDelta: (text: string) => void;
  onToolCall: (name: string, args: Record<string, unknown>) => void;
  onToolResult: (name: string, result: string) => void;
  onDone: (fullText: string) => void;
  onError: (error: Error) => void;
}

const MAX_TOOL_OUTPUT_CHARS = 12_000;
// Must stay even: tool items are always pushed as call/output pairs.
const KEPT_TOOL_ITEMS = 30;
const FULL_TOOL_ITEMS = 16;
const OLD_OUTPUT_CHARS = 400;

function encodeToolOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) return output;
  return output.slice(0, MAX_TOOL_OUTPUT_CHARS) + `\n[...${t("truncated")}]`;
}

function compressInputHistory(input: InputItem[]): InputItem[] {
  const messages = input.filter(
    (i): i is Extract<InputItem, { type: "message" }> => i.type === "message",
  );
  const toolItems = input.filter((item) => item.type !== "message");
  const kept = toolItems.slice(-KEPT_TOOL_ITEMS);

  const compressed = kept.map((item, idx) => {
    const isRecent = idx >= kept.length - FULL_TOOL_ITEMS;
    if (isRecent) return item;
    if (item.type === "function_call") {
      return { ...item, arguments: "{}" };
    }
    if (item.type === "function_call_output" && item.output.length > OLD_OUTPUT_CHARS) {
      return { ...item, output: item.output.slice(0, OLD_OUTPUT_CHARS) + `\n[...${t("client.old_result")}]` };
    }
    return item;
  });

  return [...messages, ...compressed];
}

export class LibreChatClient {
  private baseUrl: string;
  private apiKey: string;
  private modelId: string;
  private _agentMode: boolean;
  private toolsEnabled: boolean = true;
  private knownAgents: Set<string> = new Set();
  private mcp: McpManager | null = null;
  private toolBudget: number = Infinity;

  constructor(config: Config, agentId: string) {
    this.baseUrl = `${config.url.replace(/\/+$/, "")}/api/agents/v1`;
    this.apiKey = config.apiKey;
    this.modelId = agentId;
    this._agentMode = this.looksLikeAgent(agentId);
  }

  setAgent(id: string): void {
    this.modelId = id;
    this._agentMode = this.looksLikeAgent(id);
  }

  private looksLikeAgent(id: string): boolean {
    return id.startsWith("agent_") || this.knownAgents.has(id);
  }

  getAgent(): string {
    return this.modelId;
  }

  isAgentMode(): boolean {
    return this._agentMode;
  }

  setToolsEnabled(enabled: boolean): void {
    this.toolsEnabled = enabled;
  }

  getToolsEnabled(): boolean {
    return this.toolsEnabled;
  }

  setMcp(mcp: McpManager): void {
    this.mcp = mcp;
  }

  async listModels(): Promise<Array<{ id: string; name?: string }>> {
    const res = await fetch(`${this.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      data: Array<{ id: string; name?: string }>;
    };
    this.knownAgents = new Set(data.data.map((m) => m.id));
    this._agentMode = this.looksLikeAgent(this.modelId);
    return data.data;
  }

  async listLLMModels(): Promise<string[]> {
    const rootUrl = this.baseUrl.replace(/\/api\/agents\/v1$/, "");
    const all: string[] = [];
    const endpoints = [`${rootUrl}/api/models`, `${this.baseUrl}/models`];
    for (const url of endpoints) {
      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${this.apiKey}` },
        });
        if (!res.ok) continue;
        const data = (await res.json()) as unknown;
        this.extractModelIds(data, all);
        if (all.length > 0) break;
      } catch { /* try next */ }
    }
    return [...new Set(all)].filter((id) => !this.knownAgents.has(id)).sort();
  }

  private extractModelIds(data: unknown, out: string[]): void {
    if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item === "string") out.push(item);
        else if (item && typeof item === "object") {
          const obj = item as Record<string, unknown>;
          if (typeof obj["id"] === "string") out.push(obj["id"]);
          if (typeof obj["model"] === "string") out.push(obj["model"]);
        }
      }
    } else if (data && typeof data === "object") {
      const obj = data as Record<string, unknown>;
      if (Array.isArray(obj["data"])) {
        this.extractModelIds(obj["data"], out);
      } else {
        for (const val of Object.values(obj)) {
          if (Array.isArray(val)) this.extractModelIds(val, out);
        }
      }
    }
  }

  async send(
    history: InputItem[],
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.sendAgent(history, callbacks, signal);
  }

  private async sendAgent(
    history: InputItem[],
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    let fullText = "";
    const contextPrefix = this.buildContextPrefix();
    let currentInput: InputItem[] = [...contextPrefix, ...history];
    const builtinTools: ToolDef[] = this.toolsEnabled ? [...toolDefinitions] : [];
    const allMcpTools = this.mcp && this.toolsEnabled ? this.mcp.getToolDefs() : [];
    let activeMcpTools = allMcpTools.slice(0, this.toolBudget);
    let tools: ToolDef[] = [...builtinTools, ...activeMcpTools];
    let roundTrips = 0;

    const MAX_TOOL_ROUNDS = 15;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (signal?.aborted) return;

      if (roundTrips >= MAX_TOOL_ROUNDS) {
        callbacks.onError(new Error(t("client.max_rounds")));
        return;
      }

      if (roundTrips > 0) {
        await new Promise((r) => setTimeout(r, 3000));
      }
      roundTrips++;

      try {
        const isFollowUp = roundTrips > 1;
        const inputToSend = isFollowUp
          ? compressInputHistory(currentInput)
          : currentInput;

        let result: { text: string; functionCalls: StreamedFunctionCall[] };
        try {
          result = isFollowUp
            ? await this.callResponsesNoStream(inputToSend, tools, callbacks, signal)
            : await this.streamResponses(inputToSend, tools, callbacks, signal);
        } catch (apiErr) {
          const msg = apiErr instanceof Error ? apiErr.message : String(apiErr);
          const match = msg.match(/array too long.*?length\s+(\d+).*?length\s+(\d+)/i);
          if (match && allMcpTools.length > 0) {
            const maxAllowed = parseInt(match[1]!, 10);
            const got = parseInt(match[2]!, 10);
            this.toolBudget = Math.max(0, activeMcpTools.length - (got - maxAllowed));
            activeMcpTools = allMcpTools.slice(0, this.toolBudget);
            tools = [...builtinTools, ...activeMcpTools];
            result = isFollowUp
              ? await this.callResponsesNoStream(inputToSend, tools, callbacks, signal)
              : await this.streamResponses(inputToSend, tools, callbacks, signal);
          } else {
            throw apiErr;
          }
        }
        fullText += result.text;

        if (result.functionCalls.length === 0) {
          if (this.mcp && this.toolBudget > 0 && this.toolBudget < allMcpTools.length && result.text) {
            const catalog = this.mcp.getToolCatalog();
            const activeNames = new Set(activeMcpTools.map((td) => td.name));
            const requested: string[] = [];
            for (const entry of catalog) {
              if (!activeNames.has(entry.name) && result.text.includes(entry.name)) {
                requested.push(entry.name);
              }
            }
            if (requested.length > 0) {
              const newTools = this.mcp
                .getToolDefsByNames(new Set(requested))
                .slice(0, this.toolBudget);
              const keep = activeMcpTools.slice(0, this.toolBudget - newTools.length);
              activeMcpTools = [...keep, ...newTools];
              tools = [...builtinTools, ...activeMcpTools];
              currentInput.push({
                type: "message",
                role: "user",
                content: t("client.mcp_ready", requested.join(", ")),
              });
              continue;
            }
          }
          callbacks.onDone(fullText);
          return;
        }

        const dedupMap = new Map<string, StreamedFunctionCall[]>();
        for (const fc of result.functionCalls) {
          const key = `${fc.name}:${fc.arguments}`;
          const group = dedupMap.get(key);
          if (group) {
            group.push(fc);
          } else {
            dedupMap.set(key, [fc]);
          }
        }

        for (const [, group] of dedupMap) {
          const fc = group[0]!;
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(fc.arguments) as Record<string, unknown>;
          } catch {
            args = {};
          }

          callbacks.onToolCall(fc.name, args);

          const toolResult = this.mcp?.hasTool(fc.name)
            ? await this.mcp.callTool(fc.name, args)
            : executeTool(fc.name, args);
          callbacks.onToolResult(fc.name, toolResult.output);

          let output = encodeToolOutput(toolResult.output);
          const failed = toolResult.isError || /^(Fejl|Error|Ukendt værktøj|Unknown tool)/.test(toolResult.output);
          if (failed) {
            output += `\n\n${t("client.tool_hint")}`;
          }
          for (const dup of group) {
            currentInput.push({
              type: "function_call",
              id: dup.id,
              call_id: dup.call_id,
              name: dup.name,
              arguments: dup.arguments,
              status: "completed",
            });
            currentInput.push({
              type: "function_call_output",
              call_id: dup.call_id,
              output,
            });
          }
        }
      } catch (err) {
        if (signal?.aborted) return;
        const error = err instanceof Error ? err : new Error(String(err));
        callbacks.onError(error);
        return;
      }
    }
  }

  private buildContextPrefix(): InputItem[] {
    const cwd = process.cwd();
    let fileList = "";
    try {
      const entries = readdirSync(cwd)
        .filter(e => !e.startsWith(".") || e === ".env" || e === ".gitignore")
        .slice(0, 40);
      fileList = entries.join(", ");
    } catch { /* ignore */ }

    let mcpInfo = "";
    if (this.mcp && this.mcp.toolCount() > 0) {
      const catalog = this.mcp.getToolCatalog();
      const catalogLines = catalog.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n");
      mcpInfo = `\n\n${t("client.mcp_available")}\n${catalogLines}`;
      if (this.toolBudget < catalog.length) {
        mcpInfo += `\n\n${t("client.mcp_budget", this.toolBudget)}`;
      }
    }

    return [
      {
        type: "message",
        role: "user",
        content: `[${t("ctx.label")}] ${t("ctx.working_in")} ${cwd}\n${t("ctx.files_in_root")} ${fileList}\n\n${t("ctx.system")}${mcpInfo}`,
      },
      {
        type: "message",
        role: "assistant",
        content: t("ctx.understood"),
      },
    ];
  }

  private async callResponsesNoStream(
    input: InputItem[],
    tools: ToolDef[],
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<{ text: string; functionCalls: StreamedFunctionCall[] }> {
    const body: Record<string, unknown> = {
      model: this.modelId,
      input,
      stream: false,
    };
    if (tools.length > 0) {
      body["tools"] = tools;
      body["reasoning_effort"] = "none";
    }

    const jsonBody = JSON.stringify(body);

    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) throw new Error(t("cancelled"));

      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/responses`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: jsonBody,
          signal,
        });
      } catch (fetchErr) {
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        throw fetchErr;
      }

      if (!res.ok) {
        const errText = await res.text();
        let detail = errText;
        try {
          const parsed = JSON.parse(errText) as { error?: { message?: string }; message?: string };
          detail = parsed.error?.message ?? parsed.message ?? errText;
        } catch { /* use raw text */ }

        if (detail.includes("terminated") && attempt === 0) {
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        throw new Error(`HTTP ${res.status}: ${detail}`);
      }

      const data = (await res.json()) as Record<string, unknown>;

      const respStatus = data["status"] as string | undefined;
      if (respStatus === "failed" || respStatus === "cancelled") {
        const error = data["error"] as Record<string, unknown> | undefined;
        const msg = (error?.["message"] as string) ?? respStatus;
        if (msg.includes("terminated") && attempt === 0) {
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        throw new Error(msg);
      }

      let text = "";
      const functionCalls: StreamedFunctionCall[] = [];

      const output = data["output"] as Array<Record<string, unknown>> | undefined;
      if (output) {
        for (const item of output) {
          if (item["type"] === "message") {
            const content = item["content"] as Array<Record<string, unknown>> | undefined;
            if (content) {
              for (const part of content) {
                if (part["type"] === "output_text") {
                  const txt = (part["text"] as string) ?? "";
                  text += txt;
                  callbacks.onDelta(txt);
                }
              }
            }
          } else if (item["type"] === "function_call") {
            functionCalls.push({
              id: (item["id"] as string) ?? "",
              call_id: (item["call_id"] as string) ?? "",
              name: (item["name"] as string) ?? "",
              arguments: (item["arguments"] as string) ?? "{}",
            });
          }
        }
      }

      return { text, functionCalls };
    }

    throw new Error(t("client.repeated_errors"));
  }

  private async streamResponses(
    input: InputItem[],
    tools: ToolDef[],
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<{ text: string; functionCalls: StreamedFunctionCall[] }> {
    const body: Record<string, unknown> = {
      model: this.modelId,
      input,
      stream: true,
    };
    if (tools.length > 0) {
      body["tools"] = tools;
      body["reasoning_effort"] = "none";
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) throw new Error(t("cancelled"));

      const res = await fetch(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        let detail = errText;
        try {
          const parsed = JSON.parse(errText) as { error?: { message?: string }; message?: string };
          detail = parsed.error?.message ?? parsed.message ?? errText;
        } catch { /* use raw text */ }

        if (res.status === 429 && attempt === 0) {
          await new Promise((r) => setTimeout(r, 30000));
          continue;
        }

        throw new Error(`HTTP ${res.status}: ${detail}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      let text = "";
      let receivedAnyEvent = false;
      const functionCalls: StreamedFunctionCall[] = [];
      const pendingFCs = new Map<number, StreamedFunctionCall>();

      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;

            try {
              const event = JSON.parse(data) as Record<string, unknown>;
              const type = event["type"] as string;
              receivedAnyEvent = true;

              if (type === "response.output_text.delta") {
                const delta = event["delta"] as string;
                if (delta) {
                  text += delta;
                  callbacks.onDelta(delta);
                }
              } else if (type === "response.output_item.added") {
                const item = event["item"] as Record<string, unknown> | undefined;
                if (item?.["type"] === "function_call") {
                  const idx = (event["output_index"] as number) ?? pendingFCs.size;
                  pendingFCs.set(idx, {
                    id: (item["id"] as string) ?? "",
                    call_id: (item["call_id"] as string) ?? "",
                    name: (item["name"] as string) ?? "",
                    arguments: "",
                  });
                }
              } else if (type === "response.function_call_arguments.delta") {
                const idx = (event["output_index"] as number) ?? 0;
                const fc = pendingFCs.get(idx);
                if (fc) {
                  fc.arguments += (event["delta"] as string) ?? "";
                }
              } else if (type === "response.output_item.done") {
                const item = event["item"] as Record<string, unknown> | undefined;
                if (item?.["type"] === "function_call") {
                  const idx = (event["output_index"] as number) ?? 0;
                  const fc = pendingFCs.get(idx);
                  if (fc) {
                    fc.id = (item["id"] as string) ?? fc.id;
                    fc.call_id = (item["call_id"] as string) ?? fc.call_id;
                    fc.name = (item["name"] as string) ?? fc.name;
                    fc.arguments = (item["arguments"] as string) ?? fc.arguments;
                    functionCalls.push(fc);
                    pendingFCs.delete(idx);
                  }
                }
              }
            } catch {
              // skip malformed events
            }
          }
        }
      } catch (streamErr) {
        if (signal?.aborted) throw new Error(t("cancelled"));

        if (!receivedAnyEvent && attempt === 0) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }

        if (!text && functionCalls.length === 0) {
          return this.callResponsesNoStream(input, tools, callbacks, signal);
        }
      }

      for (const fc of pendingFCs.values()) {
        if (fc.name) functionCalls.push(fc);
      }

      if (!text && functionCalls.length === 0 && receivedAnyEvent && attempt === 0) {
        return this.callResponsesNoStream(input, tools, callbacks, signal);
      }

      return { text, functionCalls };
    }

    throw new Error(t("client.rate_limit"));
  }

  private async sendModel(
    history: InputItem[],
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    const messages = history
      .filter((m): m is Extract<InputItem, { type: "message" }> => m.type === "message")
      .map((m) => ({ role: m.role, content: m.content }));

    let fullText = "";
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.modelId,
          messages,
          stream: true,
        }),
        signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data) as {
              choices: Array<{ delta: { content?: string } }>;
            };
            const delta = parsed.choices[0]?.delta?.content;
            if (delta) {
              fullText += delta;
              callbacks.onDelta(delta);
            }
          } catch {
            // skip malformed chunks
          }
        }
      }

      callbacks.onDone(fullText);
    } catch (err) {
      if (signal?.aborted) return;
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
