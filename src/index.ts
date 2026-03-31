/**
 * index.ts — Entry point for mem-persistence MCP server
 *
 * Transport modes:
 *   stdio (default)  — local use with Claude Desktop, Cursor, Claude Code
 *   http  (--port N) — remote use via Tailscale or local network
 *
 * Usage:
 *   node dist/index.js --workspace /path/to/workspace          # stdio
 *   node dist/index.js --workspace /path/to/workspace --port 3456  # HTTP
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { defaultConfig } from "./memory.js";
import { resolve } from "path";
import http from "http";

async function main() {
  const args = process.argv.slice(2);
  let workspace = process.cwd();
  let port: number | null = null;
  let host = "127.0.0.1"; // safe default — only listen locally

  // Parse CLI args
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--workspace" && args[i + 1]) {
      workspace = resolve(args[++i]);
    } else if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[++i], 10);
    } else if (args[i] === "--host" && args[i + 1]) {
      host = args[++i];
    }
  }

  // Env var overrides
  if (process.env.MEM_PERSISTENCE_WORKSPACE) {
    workspace = resolve(process.env.MEM_PERSISTENCE_WORKSPACE);
  }
  if (process.env.MEM_PERSISTENCE_PORT) {
    port = parseInt(process.env.MEM_PERSISTENCE_PORT, 10);
  }
  if (process.env.MEM_PERSISTENCE_HOST) {
    host = process.env.MEM_PERSISTENCE_HOST;
  }

  const config = defaultConfig(workspace);

  // Override dedup threshold
  if (process.env.MEM_PERSISTENCE_DEDUP_THRESHOLD) {
    config.dedupThreshold = parseFloat(process.env.MEM_PERSISTENCE_DEDUP_THRESHOLD);
  }

  // Embedding config from env vars
  const embProvider = process.env.MEM_PERSISTENCE_EMBEDDINGS || "none";
  if (embProvider === "gemini" || embProvider === "openai") {
    config.embeddings = {
      provider: embProvider,
      apiKey:
        process.env.MEM_PERSISTENCE_EMBEDDINGS_API_KEY ||
        (embProvider === "gemini"
          ? process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY
          : process.env.OPENAI_API_KEY),
      model: process.env.MEM_PERSISTENCE_EMBEDDINGS_MODEL,
    };
  }

  if (port !== null) {
    // ── HTTP mode ─────────────────────────────────────────────────────────
    const httpServer = http.createServer(async (req, res) => {
      if (req.url === "/mem-persistence/mcp" || req.url === "/mem-persistence/mcp/") {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        const server = createServer(config);
        await server.connect(transport);
        await transport.handleRequest(req, res);
        transport.onclose = () => { server.close(); };
        return;
      }

      // Health check
      if (req.url === "/health" || req.url === "/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", server: "mem-persistence", workspace }));
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    httpServer.listen(port, host, () => {
      console.error(`mem-persistence HTTP server listening on http://${host}:${port}`);
      console.error(`MCP endpoint: http://${host}:${port}/mem-persistence/mcp`);
      console.error(`Workspace: ${workspace}`);
      console.error(`⚠️  Do NOT expose this port to the public internet. Use Tailscale or a VPN.`);
    });
  } else {
    // ── stdio mode (default) ───────────────────────────────────────────────
    const server = createServer(config);
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
