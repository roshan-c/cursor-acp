# Cursor → ACP Adapter

[![npm version](https://img.shields.io/npm/v/cursor-acp.svg)](https://www.npmjs.com/package/cursor-acp)

An adapter that bridges the Cursor CLI agent (`cursor-agent`) to the Agent Client Protocol (ACP). It exposes the Cursor agent over ACP's ndjson stream so any ACP client can drive it. So far, it can be used in these clients:
- Zed
- JetBrains (coming soon)
- AionUi
- Emacs via agent-shell.el
- marimo notebook
- neovim
  - through the CodeCompanion plugin
  - through the yetone/avante.nvim plugin


## Features
- Prompt streaming: forwards assistant/user chunks from Cursor to ACP in real time
- Tool call mapping:
  - Search: `grepToolCall`/`globToolCall` → ACP tool_call with summaries and file `locations`
  - Execute: `bashToolCall`/`shellToolCall` → ACP tool_call with output + exit code
  - Read/Write: map to content blocks and diffs
- Modes: `default` and `plan` mode, including `current_mode_update`
- Cancellation: keeps streaming updates, responds with `cancelled`, and flushes final updates before resolve
- Auth hint: if the Cursor CLI requires auth, emits a helpful login message

## Install

- Node.js 18+
- Cursor CLI (`cursor-agent`) installed and on PATH

Install via npm:

```bash
npm install -g cursor-acp
```

Or install locally in your project:

```bash
npm install cursor-acp
```

## Usage

Expose the ACP server:

```bash
cursor-acp
```

If installed locally (without `-g`), use:

```bash
npx cursor-acp
```

Or if building from source:

```bash
npm install
npm run build
node ./dist/index.js
```

By default, the adapter calls `cursor-agent` on your PATH. To use a specific binary:

```bash
export CURSOR_AGENT_EXECUTABLE=/full/path/to/cursor-agent
```

Authenticate Cursor if needed:

```bash
cursor-agent login
```

## Integration (ACP Client)

Point your ACP client to the adapter’s stdio process. For SDK-based clients, use `ndJsonStream` with the adapter’s stdin/stdout.

### Minimal Client Snippet (Node)

```js
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ndJsonStream, ClientSideConnection, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const env = { ...process.env };
// Optional: target a specific Cursor binary
// env.CURSOR_AGENT_EXECUTABLE = "/usr/local/bin/cursor-agent";

// Start the adapter (if installed via npm)
const proc = spawn("cursor-acp", [], { stdio: ["pipe", "pipe", "inherit"], env });

// Or if installed locally:
// const proc = spawn("npx", ["cursor-acp"], { stdio: ["pipe", "pipe", "inherit"], env });

// Wire ACP stream
const input = Writable.toWeb(proc.stdin);
const output = Readable.toWeb(proc.stdout);
const stream = ndJsonStream(input, output);

// Minimal client
class Client { async requestPermission({ options }) { return { outcome: { outcome: "selected", optionId: options?.[0]?.optionId ?? "allow-once" } }; }
  async sessionUpdate(u) { if (u.update.sessionUpdate === "agent_message_chunk" && u.update.content.type === "text") console.log(u.update.content.text); } }

const conn = new ClientSideConnection(() => new Client(), stream);

// Drive a simple prompt
const init = await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
const { sessionId } = await conn.newSession({ cwd: process.cwd(), mcpServers: [] });
const res = await conn.prompt({ sessionId, prompt: [{ type: "text", text: "Say hello" }] });
console.log("stopReason=", res.stopReason);
proc.kill();
```

## Zed

Use this adapter as an External Agent in Zed.

1) Install the adapter

```bash
npm install -g cursor-acp
```

2) Configure Zed (settings.json)

Add an entry under `agent_servers` pointing to the installed adapter:

```jsonc
"agent_servers": {
  // ... your other agents
  "Cursor": {
    "command": "cursor-acp",
    "args": [],
    "env": {
      // Optional: only if cursor-agent isn't on PATH
      // "CURSOR_AGENT_EXECUTABLE": "/usr/local/bin/cursor-agent"
    }
  }
}
```

Alternatively, if you prefer to build from source:

```bash
npm install
npm run build
```

Then configure Zed to use the built file:

```jsonc
"agent_servers": {
  "Cursor": {
    "command": "node",
    "args": ["/absolute/path/to/cursor-acp/dist/index.js"],
    "env": {}
  }
}
```

3) Use it in Zed

- Open the Agent panel in Zed.
- Click "+" → New Thread → choose "Cursor".
- If prompted to authenticate, run `cursor-agent login` in a terminal and retry.

## Environment

- `CURSOR_AGENT_EXECUTABLE` – optional path to the Cursor binary (defaults to `cursor-agent`)

## Notes

- The adapter forwards tool call updates even after cancellation, then responds with `cancelled` as required by ACP.
- For shell tools, empty stdout is rendered as “(no output)” and exit code is included when provided.

## Development

To build from source:

```bash
git clone https://github.com/roshan-c/cursor-acp.git
cd cursor-acp
npm install
npm run build
```

- Build: `npm run build`
- Watch: `npm run dev`

## License

MIT
