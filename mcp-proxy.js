#!/usr/bin/env node
/**
 * mcp-proxy.js — stdio-to-HTTP proxy for MCP servers
 *
 * Allows Claude Desktop (stdio-only) to connect to a remote mem-persistence
 * server over HTTP. Zero dependencies — only Node.js built-ins.
 *
 * Usage in Claude Desktop config:
 * {
 *   "mcpServers": {
 *     "memory": {
 *       "command": "node",
 *       "args": ["/path/to/mcp-proxy.js"],
 *       "env": {
 *         "MCP_REMOTE_URL": "http://work-linux.tailb5faba.ts.net:3456/mem-persistence/mcp"
 *       }
 *     }
 *   }
 * }
 *
 * Environment variables:
 *   MCP_REMOTE_URL  — Required. HTTP URL of the remote MCP server.
 *   MCP_DEBUG       — Optional. Set to "1" for debug logging to stderr.
 */

const http = require("http");
const https = require("https");

const REMOTE_URL = process.env.MCP_REMOTE_URL;
const DEBUG = process.env.MCP_DEBUG === "1";

if (!REMOTE_URL) {
  process.stderr.write("ERROR: MCP_REMOTE_URL environment variable is required.\n");
  process.stderr.write("Set it to your remote mem-persistence HTTP URL, e.g.:\n");
  process.stderr.write("  MCP_REMOTE_URL=http://work-linux.tailb5faba.ts.net:3456/mem-persistence/mcp\n");
  process.exit(1);
}

const url = new URL(REMOTE_URL);
const transport = url.protocol === "https:" ? https : http;

function debug(msg) {
  if (DEBUG) process.stderr.write(`[mcp-proxy] ${msg}\n`);
}

/**
 * Forward a JSON-RPC message to the remote server via HTTP POST.
 * Handles both regular JSON responses and SSE streams.
 */
function forwardToRemote(message) {
  const body = JSON.stringify(message);
  debug(`→ ${body.slice(0, 200)}`);

  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === "https:" ? 443 : 80),
    path: url.pathname + url.search,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      Accept: "application/json, text/event-stream",
    },
    timeout: 30000,
  };

  const req = transport.request(options, (res) => {
    const contentType = res.headers["content-type"] || "";

    if (contentType.includes("text/event-stream")) {
      // SSE response — collect data events and forward each as a line to stdout
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop(); // keep incomplete line in buffer
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data && data !== "[DONE]") {
              debug(`← SSE: ${data.slice(0, 200)}`);
              process.stdout.write(data + "\n");
            }
          }
        }
      });
      res.on("end", () => {
        // flush remaining buffer
        if (buffer.startsWith("data: ")) {
          const data = buffer.slice(6).trim();
          if (data && data !== "[DONE]") {
            process.stdout.write(data + "\n");
          }
        }
      });
    } else {
      // Regular JSON response
      let responseBody = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (responseBody += chunk));
      res.on("end", () => {
        debug(`← ${responseBody.slice(0, 200)}`);
        if (responseBody.trim()) {
          process.stdout.write(responseBody.trim() + "\n");
        }
      });
    }
  });

  req.on("error", (err) => {
    debug(`ERROR: ${err.message}`);
    // Send JSON-RPC error response back to Desktop
    if (message.id !== undefined) {
      const errorResponse = JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: `Remote server error: ${err.message}`,
        },
      });
      process.stdout.write(errorResponse + "\n");
    }
  });

  req.on("timeout", () => {
    debug("ERROR: Request timed out");
    req.destroy();
    if (message.id !== undefined) {
      const errorResponse = JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32000,
          message: "Remote server timed out",
        },
      });
      process.stdout.write(errorResponse + "\n");
    }
  });

  req.write(body);
  req.end();
}

// Read JSON-RPC messages from stdin (one per line, newline-delimited)
let inputBuffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;
  const lines = inputBuffer.split("\n");
  inputBuffer = lines.pop(); // keep incomplete line

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const message = JSON.parse(trimmed);
      forwardToRemote(message);
    } catch (err) {
      debug(`Parse error: ${err.message} — line: ${trimmed.slice(0, 100)}`);
    }
  }
});

process.stdin.on("end", () => {
  debug("stdin closed, exiting.");
  process.exit(0);
});

// Keep alive
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

debug(`Proxy started: stdio → ${REMOTE_URL}`);
