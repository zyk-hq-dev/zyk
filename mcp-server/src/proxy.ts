/**
 * Stdio → HTTP proxy for Zyk.
 *
 * Lets Claude Desktop (which only supports stdio MCP) talk to a remote Zyk
 * server (Railway or any HTTP endpoint) without any local server setup.
 *
 * Claude Desktop spawns this process via npx and pipes stdio to it.
 * The proxy forwards every MCP message to the remote HTTP server and
 * streams responses back — completely transparent to both sides.
 *
 * Usage (claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "zyk": {
 *         "command": "npx",
 *         "args": ["-y", "zyk-mcp", "--proxy", "https://your-app.railway.app/mcp"]
 *       }
 *     }
 *   }
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export async function runProxy(remoteUrl: string): Promise<void> {
  process.stderr.write(`[zyk] Connecting to ${remoteUrl}\n`);

  let httpTransport: StreamableHTTPClientTransport;
  try {
    httpTransport = new StreamableHTTPClientTransport(new URL(remoteUrl));
  } catch {
    process.stderr.write(`[zyk] Invalid URL: ${remoteUrl}\n`);
    process.exit(1);
  }

  const stdioTransport = new StdioServerTransport();

  // Claude Desktop → proxy → remote server
  stdioTransport.onmessage = async (msg) => {
    try {
      await httpTransport.send(msg);
    } catch (err) {
      process.stderr.write(`[zyk] Failed to forward to server: ${err}\n`);
    }
  };

  // Remote server → proxy → Claude Desktop
  httpTransport.onmessage = async (msg) => {
    try {
      await stdioTransport.send(msg);
    } catch (err) {
      process.stderr.write(`[zyk] Failed to forward to client: ${err}\n`);
    }
  };

  httpTransport.onerror = (err) => {
    process.stderr.write(`[zyk] Server error: ${err.message}\n`);
  };

  stdioTransport.onerror = (err) => {
    process.stderr.write(`[zyk] stdio error: ${err.message}\n`);
  };

  httpTransport.onclose = () => process.exit(0);
  stdioTransport.onclose = () => process.exit(0);

  try {
    await httpTransport.start();
    await stdioTransport.start();
    process.stderr.write(`[zyk] Connected — proxying stdio → ${remoteUrl}\n`);
  } catch (err) {
    process.stderr.write(
      `[zyk] Could not connect to ${remoteUrl}\n` +
      `[zyk] Make sure your Zyk server is running and the URL is correct.\n` +
      `[zyk] Error: ${err}\n`
    );
    process.exit(1);
  }
}
