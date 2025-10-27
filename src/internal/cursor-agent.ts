import {
  Agent,
  AgentSideConnection,
  AvailableCommand,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SessionModelState,
  SetSessionModelRequest,
  SetSessionModeRequest,
  SetSessionModeResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";

interface SessionState {
  cwd?: string;
  cancelled: boolean;
  resumeId?: string; // cursor session_id to resume
  modeId: "default" | "plan";
  running?: ChildProcess | null;
}

export class CursorAcpAgent implements Agent {
  private client: AgentSideConnection;
  private sessions: Record<string, SessionState> = {};

  constructor(client: AgentSideConnection) {
    this.client = client;
  }

  async initialize(req: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        promptCapabilities: { image: false, embeddedContext: true },
      },
      authMethods: [
        {
          id: "cursor-login",
          name: "Log in with Cursor Agent",
          description: "Run `cursor-agent login` in your terminal",
        },
      ],
    };
  }

  async authenticate(_params: any): Promise<void> {
    throw new Error("Not implemented: authentication is handled via cursor-agent login");
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const id = cryptoRandomId();
    this.sessions[id] = {
      cwd: params.cwd,
      cancelled: false,
      modeId: "default",
    };

    const models: SessionModelState = {
      availableModels: [{ modelId: "default", name: "Default", description: "Cursor default" }],
      currentModelId: "default",
    };

    const availableCommands: AvailableCommand[] = [];

    const modes = [
      { id: "default", name: "Always Ask", description: "Normal behavior" },
      { id: "plan", name: "Plan Mode", description: "Analyze only; avoid edits and commands" },
    ];

    // Send async available commands update after return if needed
    setTimeout(() => {
      this.client.sessionUpdate({
        sessionId: id,
        update: { sessionUpdate: "available_commands_update", availableCommands },
      });
    }, 0);

    return { sessionId: id, models, modes: { currentModeId: "default", availableModes: modes } };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions[params.sessionId];
    if (!session) throw new Error("Session not found");

    session.cancelled = false;

    const cmd = process.env.CURSOR_AGENT_EXECUTABLE || "cursor-agent";

    const planPrefix =
      session.modeId === "plan" ? "[PLAN MODE] Do not edit files or run commands. Analyze only.\n\n" : "";

    const initialPrompt = planPrefix + concatPromptChunks(params.prompt);

    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
    ];

    if (session.resumeId) {
      args.push("--resume", session.resumeId);
    }

    if (initialPrompt && initialPrompt.length > 0) {
      args.push(initialPrompt);
    }

    const child = spawn(cmd, args, {
      cwd: session.cwd || process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    
    child.stderr.on("data", (buf: Buffer) => {
      const s = buf.toString("utf8");
      if (/login/i.test(s) && /cursor-agent/i.test(s)) {
        this.client.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Authentication required. Please run `cursor-agent login` in your terminal, then retry the prompt." },
          },
        });
      }
    });
    session.running = child;

    // Parse NDJSON from stdout
    const rl = readline.createInterface({ input: child.stdout });
    let stopReason: PromptResponse["stopReason"] | undefined;
    let lastAssistantText = "";

    rl.on("line", (line) => {
      try {
        const evt = JSON.parse(line);
        for (const note of mapCursorEventToAcp(params.sessionId, evt, lastAssistantText)) {
          this.client.sessionUpdate(note);
        }
        // Track the last assistant text for deduplication
        if (evt.type === "assistant") {
          const text = evt?.message?.content?.[0]?.text ?? "";
          if (text) lastAssistantText = text;
        }
        if (evt.type === "result") {
          if (evt.subtype === "success") {
            stopReason = "end_turn";
          } else if (evt.subtype === "cancelled") {
            stopReason = "cancelled";
          } else if (evt.subtype === "error" || evt.subtype === "failure" || evt.subtype === "refused") {
            stopReason = "refusal";
          }
        }
        if (evt.session_id && !session.resumeId) {
          session.resumeId = evt.session_id;
        }
      } catch (e) {
        // ignore non-JSON noise
      }
    });

    const done = new Promise<PromptResponse>((resolve) => {
      let exited = false;
      let exitCode: number | null = null;
      const maybeResolve = () => {
        // Wait for rl to close to ensure all updates are flushed before responding
        if (!exited) return;
        const finalize = () => {
          session.running = null;
          if (session.cancelled) return resolve({ stopReason: "cancelled" });
          if (stopReason) return resolve({ stopReason });
          resolve({ stopReason: exitCode === 0 ? "end_turn" : "refusal" });
        };
        // If rl already closed, finalize immediately; otherwise wait briefly
        if ((rl as any).closed) return finalize();
        const timer = setTimeout(finalize, 300);
        rl.once("close", () => {
          clearTimeout(timer);
          finalize();
        });
      };

      child.on("exit", (code) => {
        exited = true;
        exitCode = code ?? null;
        maybeResolve();
      });
    });

    return await done;
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions[params.sessionId];
    if (!session) throw new Error("Session not found");
    session.cancelled = true;
    const child = session.running;
    if (child && !child.killed) {
      try {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 1000);
      } catch {}
    }
  }

  async setSessionModel(_params: SetSessionModelRequest): Promise<void> {
    // Cursor CLI model selection via flag is not wired in v1
    return;
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.sessions[params.sessionId];
    if (!session) throw new Error("Session not found");
    switch (params.modeId) {
      case "default":
      case "plan":
        session.modeId = params.modeId as any;
        // notify client of current mode update
        this.client.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: session.modeId } });
        return {};
      default:
        throw new Error("Invalid Mode");
    }
  }
}

function concatPromptChunks(chunks: PromptRequest["prompt"]): string {
  const parts: string[] = [];
  for (const chunk of chunks) {
    if (chunk.type === "text") parts.push(chunk.text);
    else if (chunk.type === "resource" && "text" in chunk.resource) parts.push(chunk.resource.text);
    else if (chunk.type === "resource_link") parts.push(chunk.uri);
  }
  return parts.join("\n\n");
}

function cryptoRandomId() {
  // simple unique id; Node 18+ has crypto.randomUUID
  try {
    return (globalThis as any).crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function buildToolTitle(kind: string, args: any): string {
  switch (kind) {
    case "readToolCall":
      return args?.path ? `Read ${args.path}` : "Read";
    case "writeToolCall":
      return args?.path ? `Write ${args.path}` : "Write";
    case "grepToolCall":
      if (args?.pattern && args?.path) return `Search ${args.path} for ${args.pattern}`;
      if (args?.pattern) return `Search for ${args.pattern}`;
      return "Search";
    case "globToolCall":
      return args?.pattern ? `Glob ${args.pattern}` : "Glob";
    case "bashToolCall":
    case "shellToolCall": {
      const cmd = args?.command ?? args?.cmd ?? (Array.isArray(args?.commands) ? args.commands.join(" && ") : undefined);
      return cmd ? "`" + String(cmd) + "`" : "Terminal";
    }
    default:
      return kind;
  }
}

function inferToolKind(kind: string): "read" | "edit" | "search" | "execute" | "other" {
  switch (kind) {
    case "readToolCall":
      return "read";
    case "writeToolCall":
      return "edit";
    case "grepToolCall":
    case "globToolCall":
      return "search";
    case "bashToolCall":
    case "shellToolCall":
      return "execute";
    default:
      return "other";
  }
}

function toLocationsFromArgs(args: any): { path: string; line?: number }[] | undefined {
  const locs: { path: string; line?: number }[] = [];
  if (typeof args?.path === "string") {
    locs.push({ path: String(args.path), line: typeof args.line === "number" ? args.line : undefined });
  }
  if (Array.isArray(args?.paths)) {
    for (const p of args.paths) {
      if (typeof p === "string") locs.push({ path: p });
      else if (p && typeof p.path === "string") locs.push({ path: p.path, line: typeof p.line === "number" ? p.line : undefined });
    }
  }
  return locs.length ? locs : undefined;
}

function toLocationsFromResult(result: any): { path: string; line?: number }[] | undefined {
  const locs: { path: string; line?: number }[] = [];
  if (!result) return undefined;
  // common shapes: { matches: [{ path, line? }, ...] } or { files: [path] }
  if (Array.isArray(result?.matches)) {
    for (const m of result.matches) {
      if (m && typeof m.path === "string") locs.push({ path: m.path, line: typeof m.line === "number" ? m.line : undefined });
      else if (typeof m === "string") locs.push({ path: m });
    }
  }
  if (Array.isArray(result?.files)) {
    for (const f of result.files) {
      if (typeof f === "string") locs.push({ path: f });
      else if (f && typeof f.path === "string") locs.push({ path: f.path, line: typeof f.line === "number" ? f.line : undefined });
    }
  }
  if (typeof result?.path === "string") {
    locs.push({ path: result.path, line: typeof result.line === "number" ? result.line : undefined });
  }
  return locs.length ? locs : undefined;
}

function summarizeSearchResult(toolKindKey: string | undefined, args: any, result: any): string | undefined {
  try {
    if (toolKindKey === "grepToolCall") {
      const matches = Array.isArray(result?.matches) ? result.matches : [];
      const count = typeof result?.count === "number" ? result.count : matches.length;
      const pat = args?.pattern ? String(args.pattern) : "pattern";
      return `Found ${count} match(es) for ${pat}`;
    }
    if (toolKindKey === "globToolCall") {
      const files = Array.isArray(result?.files) ? result.files : [];
      const count = files.length;
      const pat = args?.pattern ? String(args.pattern) : "pattern";
      return `Found ${count} file(s) matching ${pat}`;
    }
  } catch {}
  return undefined;
}

function mapCursorEventToAcp(sessionId: string, evt: any, lastAssistantText = ""): SessionNotification[] {
  const out: SessionNotification[] = [];
  switch (evt.type) {
    case "user": {
      // Skip user events to avoid echoing the user's message back to the client
      // The client already knows what the user said from the prompt request
      break;
    }
    case "assistant": {
      const text = evt?.message?.content?.[0]?.text ?? "";
      if (text && text !== lastAssistantText) {
        // Only send the delta (new text) to avoid duplicate messages
        const delta = text.startsWith(lastAssistantText) ? text.slice(lastAssistantText.length) : text;
        if (delta) {
          out.push({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: delta } } });
        }
      }
      break;
    }
    case "tool_call": {
      const callId = evt.call_id ?? evt.tool_call_id ?? "";
      const started = evt.subtype === "started";
      const completed = evt.subtype === "completed";
      const toolKindKey = evt.tool_call ? Object.keys(evt.tool_call)[0] : undefined;
      const tool = toolKindKey ? evt.tool_call[toolKindKey] : undefined;
      const args = tool?.args ?? {};

      if (started) {
        const base: any = {
          sessionUpdate: "tool_call",
          toolCallId: callId,
          title: buildToolTitle(toolKindKey || "Other", args),
          kind: inferToolKind(toolKindKey || "Other"),
          status: "pending",
          rawInput: safeJson(args),
        };
        const locs = toLocationsFromArgs(args);
        if (locs) base.locations = locs;
        out.push({ sessionId, update: base });
        // Immediately mark in_progress to reflect execution start
        out.push({ sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: callId, status: "in_progress" } });
      } else if (completed) {
        const result = tool?.result?.success ?? tool?.result?.error ?? tool?.result;
        const isError = !!tool?.result?.error;
        const update: any = {
          sessionUpdate: "tool_call_update",
          toolCallId: callId,
          status: isError ? "failed" : "completed",
          rawOutput: safeJson(result),
        };

        // attach locations when available
        const locs = toLocationsFromResult(result) ?? toLocationsFromArgs(args);
        if (locs) update.locations = locs;

        // attach content for common tools
        if (toolKindKey === "readToolCall" && (result?.content ?? args?.content)) {
          const contentText = String(result?.content ?? args?.content ?? "");
          update.content = [{ type: "content", content: { type: "text", text: contentText.slice(0, 20000) } }];
        } else if (toolKindKey === "writeToolCall") {
          const path = args?.path;
          const newText = (result?.newText ?? args?.fileText ?? args?.newText ?? "");
          const oldText = result?.oldText ?? null;
          update.content = path
            ? [{ type: "diff", path, oldText, newText }]
            : [{ type: "content", content: { type: "text", text: newText } }];
        } else if (toolKindKey === "bashToolCall" || toolKindKey === "shellToolCall") {
          let output = result?.output ?? result?.stdout ?? "";
          const exit = typeof result?.exitCode === "number" ? result.exitCode : undefined;
          const outText = String(output);
          const normalized = outText.trim().length === 0 ? "(no output)" : outText;
          const text = (exit !== undefined ? `Exit code: ${exit}\n` : "") + normalized;
          update.content = [{ type: "content", content: { type: "text", text: "```\n" + text + "\n```" } }];
        } else if (toolKindKey === "grepToolCall" || toolKindKey === "globToolCall") {
          const summary = summarizeSearchResult(toolKindKey, args, result);
          if (summary) {
            update.content = [{ type: "content", content: { type: "text", text: summary } }];
          }
        }

        out.push({ sessionId, update });
      }
      break;
    }
    case "system":
    case "result":
    default:
      break;
  }
  return out;
}

function safeJson(obj: any) {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    return undefined;
  }
}
