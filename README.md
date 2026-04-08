# mem-persistence

> 🧠 Persistent memory MCP server for AI agents — one memory, every agent, your files.

mem-persistence lets Claude Desktop, Claude Code, Cursor, Zed, and any MCP-compatible client share the same persistent memory, backed by plain Markdown files you own and can edit by hand.

## Why?

AI agents have amnesia. Each tool keeps its own silo — Claude Code forgets what OpenClaw knows, Cursor can't recall what you told Claude yesterday. Your context is scattered across sessions that evaporate.

mem-persistence fixes this:

- **Markdown is the source of truth** — not a database, not a binary blob. Files you can read, edit, and version with git.
- **Hybrid search** — token matching + semantic embeddings for accurate recall.
- **Embedding providers** — Gemini (free), OpenAI, or none (token-only). Cached to disk.
- **Deduplication** — prevents writing the same fact twice (token + entity overlap detection).
- **Works offline** — no cloud dependency. Embeddings are optional.

## MCP Tools

| Tool | Description |
|---|---|
| `memory_search(query, maxResults?)` | Hybrid search across all `.md` files |
| `memory_write(content, file?, section?)` | Write with automatic deduplication |
| `memory_read(path, from?, lines?)` | Read a specific file or section |
| `memory_checkpoint(summary)` | Save a session checkpoint to a daily note |
| `memory_entities(query?)` | Query the knowledge graph (if `entities.md` exists) |
| `memory_status()` | Index stats: files, chunks, last sync |

---

## Quick Start

### 1. Install and build

```bash
git clone https://github.com/emiliotorrens/mem-persistence.git
cd mem-persistence
npm install
npm run build
```

### 2. Start the server

```bash
node dist/index.js --workspace /path/to/your/workspace --port 3456
```

### 3. Connect a client

Pick the setup that matches your client — see [Client Setup](#client-setup) below.

### 4. Add agent instructions

Copy [`AGENT_INSTRUCTIONS.md`](AGENT_INSTRUCTIONS.md) into your agent's instruction file:

| Editor | Where to paste |
|---|---|
| Claude Desktop | Settings → Personal Preferences |
| Claude Code | `CLAUDE.md` in project root |
| Cursor | `.cursorrules` in project root |
| Windsurf | `.windsurfrules` in project root |

---

## Client Setup

There are two MCP transports. Which one you need depends on the client:

| Transport | Clients | Where server runs | Remote access |
|---|---|---|---|
| **HTTP** | Claude Code, Cursor, Zed | Anywhere (local or remote) | ✅ via Tailscale/VPN |
| **stdio** | Claude Desktop | Same machine as Desktop | ❌ (see [proxy workaround](#remote-claude-desktop-via-proxy)) |

### HTTP clients (Claude Code, Cursor, Zed)

Point to the running server URL:

```json
{
  "mcpServers": {
    "memory": {
      "url": "http://127.0.0.1:3456/mem-persistence/mcp"
    }
  }
}
```

For remote access over Tailscale, replace `127.0.0.1` with the server's Tailscale hostname:

```json
{
  "mcpServers": {
    "memory": {
      "url": "http://my-machine.tail1234.ts.net:3456/mem-persistence/mcp"
    }
  }
}
```

### Claude Desktop (stdio, same machine)

Claude Desktop only supports stdio — it spawns mem-persistence as a child process.

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": [
        "/path/to/mem-persistence/dist/index.js",
        "--workspace", "/path/to/your/workspace"
      ],
      "env": {
        "MEM_PERSISTENCE_EMBEDDINGS": "gemini",
        "GOOGLE_API_KEY": "your-key-here"
      }
    }
  }
}
```

> **WSL users (Windows):** replace `"command": "node"` with `"command": "wsl"` and add `"node"` as the first element of `args`.

> ⚠️ **Do not pass `--port` in stdio mode.** It causes an `EADDRINUSE` conflict if an HTTP instance is already running.

### Remote Claude Desktop via proxy

If Claude Desktop runs on a **different machine** (e.g., a laptop) where mem-persistence isn't installed, use the bundled `mcp-proxy.js` to bridge stdio to the remote HTTP server.

**Requirements on the client machine:** Node.js + Tailscale. That's it — no cloning, no `npm install`.

1. Copy `mcp-proxy.js` to the laptop (one file, zero dependencies).
2. Add to Claude Desktop config:

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/path/to/mcp-proxy.js"],
      "env": {
        "MCP_REMOTE_URL": "http://my-machine.tail1234.ts.net:3456/mem-persistence/mcp"
      }
    }
  }
}
```

Desktop thinks it's talking to a local stdio server; the proxy forwards everything over HTTP.

Set `MCP_DEBUG=1` to log proxy traffic to stderr for troubleshooting.

---

## Running as a Service (PM2)

For production use, run the server as a persistent background service with PM2:

```bash
# 1. Install pm2
npm install -g pm2

# 2. Copy and edit the config
cp ecosystem.config.cjs.example ecosystem.config.cjs
# → Set workspace path and optional API keys

# 3. Start and persist
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup    # autostart on reboot (follow the printed instructions)
```

Health check: `curl http://127.0.0.1:3456/health`

---

## Network Binding

By default, the server listens on `127.0.0.1` only. Use `--bind` to control which interfaces it binds to:

```bash
# Localhost + Tailscale (recommended for remote access)
node dist/index.js --workspace /path --port 3456 --bind 127.0.0.1,tailscale

# Localhost + explicit VPN IP
node dist/index.js --workspace /path --port 3456 --bind 127.0.0.1,10.0.0.5

# All interfaces (⚠️ only behind a firewall)
node dist/index.js --workspace /path --port 3456 --bind all
```

| `--bind` value | Resolves to |
|---|---|
| `localhost` | `127.0.0.1` |
| `tailscale` | Auto-detected via `tailscale ip -4` (100.x.x.x) |
| `all` / `0.0.0.0` | All network interfaces |
| Any IP | Used as-is |

In `ecosystem.config.cjs`:

```js
args: '--workspace /path --port 3456 --bind 127.0.0.1,tailscale',
```

Or via environment variable: `MEM_PERSISTENCE_BIND=127.0.0.1,tailscale`

> ⚠️ **Security:** mem-persistence has no built-in authentication. **Never expose the port to the public internet.** Use `--bind 127.0.0.1,tailscale` to limit access to localhost + your private network.

---

## Workspace

The `--workspace` flag points to the directory containing your memory files. mem-persistence indexes all `.md` files recursively.

Any directory with `.md` files works. Search quality improves with a layered layout:

| Layer | Path | Purpose |
|---|---|---|
| L1 | `MEMORY.md` | Long-term curated memory — highest search priority |
| L2 | `memory/*.md` | Daily notes, recent context |
| L3 | `reference/*.md` | Detailed data, historical records |

For automatic setup of this structure (with crons, dedup, and knowledge graph), see [layered-memstack](https://github.com/emiliotorrens/layered-memstack).

You can also set the workspace via environment variable: `MEM_PERSISTENCE_WORKSPACE=/path/to/workspace`

---

## Embeddings

By default, search uses **token matching only** (Jaccard + containment + entity overlap). No API calls, works offline.

Enabling embeddings adds **semantic understanding**:

| Query | Token-only | With embeddings |
|---|---|---|
| `"where does Emilio work"` | ❌ no keyword overlap | ✅ understands meaning |
| `"what trips are coming up?"` | ❌ misses if phrased differently | ✅ matches semantically |

**Get a free Gemini API key** → [aistudio.google.com](https://aistudio.google.com) → Get API key.

Configure via environment variables:

```bash
MEM_PERSISTENCE_EMBEDDINGS=gemini    # "gemini" or "openai"
GOOGLE_API_KEY=your-key              # Gemini — free
OPENAI_API_KEY=your-key              # OpenAI — $0.02/M tokens
```

Details:
- **Hybrid scoring**: 0.4 × token + 0.6 × vector
- **Disk cache**: `.mem-persistence/embeddings/` — no repeated API calls
- **Default model**: `gemini-embedding-001` (free, 1500 req/min)
- **Silent fallback**: if API unavailable, falls back to token-only automatically

---

## Deduplication

Before writing, mem-persistence checks if similar content already exists:

```
Input:  "GitHub configured with gh auth login, user emiliotorrens"
Match:  "gh auth login hecho — cuenta emiliotorrens, protocolo HTTPS"
Result: DUPLICATE (score: 0.90) — not written
```

Uses token similarity (Jaccard + containment) and entity overlap (IDs, dates, versions, URLs).

Adjust the threshold: `MEM_PERSISTENCE_DEDUP_THRESHOLD=0.65` (default — lower = stricter).

---

## OpenClaw Integration

If you use [OpenClaw](https://github.com/openclaw/openclaw), mem-persistence coexists with OpenClaw's native memory:

- **External clients** (Claude Desktop, Code, Cursor) → connect via mem-persistence (stdio or HTTP)
- **OpenClaw agent** → uses its native `memory-core` plugin with hybrid search + embeddings

Both systems index the same Markdown files. mem-persistence is the MCP bridge for external clients; OpenClaw handles its own recall, wiki compilation, and dreaming.

---

## Roadmap

- [x] Deduplication engine
- [x] Hybrid search (token + vector + MMR + temporal decay)
- [x] MCP server — stdio and HTTP transports, 6 tools, TypeScript + ESM
- [x] Embedding providers: Gemini (free) and OpenAI, with disk cache
- [x] Request/response logging (`.mem-persistence/logs/`)
- [x] HTTP mode — Tailscale-friendly, pm2-ready
- [x] stdio→HTTP proxy for remote Claude Desktop
- [ ] CLI (`mem-persistence search "query"`)
- [ ] Local embeddings via transformers.js (offline, no API key)
- [ ] npm publish

---

## Related

- **[layered-memstack](https://github.com/emiliotorrens/layered-memstack)** — OpenClaw skill that sets up a 3-layer memory system with automated maintenance. Uses mem-persistence as the MCP bridge for external clients.

## Credits

- **[OpenClaw](https://github.com/openclaw/openclaw)** — the agent framework where this was born and battle-tested
- **[MCP](https://modelcontextprotocol.io)** — the protocol that makes cross-agent memory possible

## License

MIT

---

Built with 🐾 by [Emilio Torrens](https://github.com/emiliotorrens) and [Claw](https://github.com/openclaw/openclaw).
