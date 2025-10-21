import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { nodeToWebReadable, nodeToWebWritable } from "./streams.js";
import { CursorAcpAgent } from "./cursor-agent.js";

export function runAcp() {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);
  const stream = ndJsonStream(input, output);
  new AgentSideConnection((client: any) => new CursorAcpAgent(client), stream);
}
