/**
 * index.ts — Entry point for mem-persistence MCP server
 *
 * Transport modes:
 *   stdio (default)  — local use with Claude Desktop, Cursor, Claude Code
 *   http  (--port N) — remote use via Tailscale or local network
 *
 * Usage:
 *   node dist/index.js --workspace /path/to/workspace                      # stdio
 *   node dist/index.js --workspace /path/to/workspace --port 3456          # HTTP (localhost only)
 *   node dist/index.js --workspace /path/to/workspace --port 3456 --bind 127.0.0.1,tailscale
 *   node dist/index.js --workspace /path/to/workspace --port 3456 --bind 127.0.0.1,100.64.0.3
 *
 * --bind accepts comma-separated IPs. Special values:
 *   tailscale  — auto-detect Tailscale IP via `tailscale ip -4`
 *   localhost  — alias for 127.0.0.1
 *   all / 0.0.0.0 — listen on all interfaces (⚠️ use only behind a firewall)
 *
 * Legacy --host flag still works for backward compatibility but --bind is preferred.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";
import { defaultConfig } from "./memory.js";
import { resolve } from "path";
import { execSync } from "child_process";
import http from "http";

// ─── Bind address resolution ────────────────────────────────────────────────

/**
 * Resolve special bind keywords to actual IPs.
 * Returns deduplicated list of IPs to bind to.
 */
async function resolveBindAddresses(raw: string[]): Promise<string[]> {
  const resolved = new Set<string>();

  for (const addr of raw) {
    const lower = addr.trim().toLowerCase();

    if (lower === "localhost" || lower === "127.0.0.1") {
      resolved.add("127.0.0.1");
    } else if (lower === "all" || lower === "0.0.0.0") {
      // 0.0.0.0 covers everything — no need for other addresses
      return ["0.0.0.0"];
    } else if (lower === "tailscale") {
      const tsIp = detectTailscaleIp();
      if (tsIp) {
        resolved.add(tsIp);
        console.error(`✅ Tailscale detected: ${tsIp}`);
      } else {
        console.error(`⚠️  Tailscale IP not found (is tailscaled running?). Skipping.`);
      }
    } else {
      // Assume it's a literal IP
      resolved.add(addr.trim());
    }
  }

  return resolved.size > 0 ? [...resolved] : ["127.0.0.1"];
}

/**
 * Try to detect the Tailscale IPv4 address.
 * Returns null if Tailscale is not installed or not connected.
 */
function detectTailscaleIp(): string | null {
  try {
    const ip = execSync("tailscale ip -4", { timeout: 3000 })
      .toString()
      .trim()
      .split("\n")[0];
    // Sanity check: Tailscale IPs are in the 100.x.x.x CGNAT range
    if (/^100\.\d+\.\d+\.\d+$/.test(ip)) return ip;
    return ip || null;
  } catch {
    return null;
  }
}

// ─── HTTP request handler ───────────────────────────────────────────────────

function createHttpHandler(config: ReturnType<typeof defaultConfig>, workspace: string) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
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
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let workspace = process.cwd();
  let port: number | null = null;
  let bindRaw: string[] | null = null;
  let legacyHost: string | null = null;

  // Parse CLI args
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--workspace" && args[i + 1]) {
      workspace = resolve(args[++i]);
    } else if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[++i], 10);
    } else if (args[i] === "--bind" && args[i + 1]) {
      bindRaw = args[++i].split(",");
    } else if (args[i] === "--host" && args[i + 1]) {
      // Legacy: --host still works for backward compat
      legacyHost = args[++i];
    }
  }

  // Env var overrides
  if (process.env.MEM_PERSISTENCE_WORKSPACE) {
    workspace = resolve(process.env.MEM_PERSISTENCE_WORKSPACE);
  }
  if (process.env.MEM_PERSISTENCE_PORT) {
    port = parseInt(process.env.MEM_PERSISTENCE_PORT, 10);
  }
  if (process.env.MEM_PERSISTENCE_BIND) {
    bindRaw = process.env.MEM_PERSISTENCE_BIND.split(",");
  } else if (process.env.MEM_PERSISTENCE_HOST) {
    // Legacy env var
    legacyHost = process.env.MEM_PERSISTENCE_HOST;
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

    // Resolve bind addresses: --bind takes priority, then legacy --host, then default
    let addresses: string[];
    if (bindRaw) {
      addresses = await resolveBindAddresses(bindRaw);
    } else if (legacyHost) {
      addresses = [legacyHost];
    } else {
      addresses = ["127.0.0.1"];
    }

    const handler = createHttpHandler(config, workspace);

    // Create one HTTP server per bind address
    for (const addr of addresses) {
      const httpServer = http.createServer(handler);
      httpServer.listen(port, addr, () => {
        console.error(`mem-persistence listening on http://${addr}:${port}`);
      });
    }

    console.error(`MCP endpoint: /mem-persistence/mcp`);
    console.error(`Workspace: ${workspace}`);
    if (!addresses.includes("0.0.0.0")) {
      console.error(`Bound to: ${addresses.join(", ")} (use --bind to change)`);
    }
    console.error(`⚠️  Do NOT expose this port to the public internet. Use Tailscale or a VPN.`);
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
