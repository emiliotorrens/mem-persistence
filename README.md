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

## Installation

```bash
# From source (npm publish coming soon)
git clone https://github.com/emiliotorrens/mem-persistence.git
cd mem-persistence
npm install
npm run build
```

## Quick Start

**1. Start the server**

```bash
node dist/index.js --workspace /path/to/your/workspace --port 3456
```

**2. Add to Claude Desktop config**

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "memory": {
      "url": "http://127.0.0.1:3456/mem-persistence/mcp"
    }
  }
}
```

**3. Add agent instructions**

Copy [`AGENT_INSTRUCTIONS.md`](AGENT_INSTRUCTIONS.md) into your editor's instructions file so the agent uses memory proactively:

| Editor | Where to paste |
|---|---|
| Claude Desktop | Settings → Personal Preferences |
| Claude Code | `CLAUDE.md` in project root |
| Cursor | `.cursorrules` in project root |
| Windsurf | `.windsurfrules` in project root |

That's it. The agent will now search memory before answering and write important facts automatically.

---

## Deployment

### HTTP mode (recommended)

Run the server once as a persistent background service. All clients connect to it via URL — no API keys needed in client configs, no new process per window.

```bash
# Install pm2 for process management
npm install -g pm2

# Copy and edit the example config
cp ecosystem.config.cjs.example ecosystem.config.cjs
# Edit ecosystem.config.cjs: set workspace path and optional API keys

# Start
pm2 start ecosystem.config.cjs
pm2 save      # persist across reboots
pm2 startup   # enable autostart on system boot
```

Client config (same for all clients — local or remote):

```json
{
  "mcpServers": {
    "memory": {
      "url": "http://127.0.0.1:3456/mem-persistence/mcp"
    }
  }
}
```

Health check: `curl http://127.0.0.1:3456/health`

### stdio mode

Claude Desktop spawns a new process on demand. Simpler to set up, but no process sharing and API keys must be in each client config.

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

> **WSL users:** replace `"command": "node"` with `"command": "wsl"` and add `"node"` as the first arg.

### Remote access via Tailscale

Access memory from multiple machines (laptop, home server, etc.) using Tailscale or any private VPN.

> ⚠️ **Never expose the port to the public internet.** mem-persistence has no authentication. Use Tailscale or a VPN.

On the host machine, start the server bound to all interfaces:

```bash
pm2 start ecosystem.config.cjs  # with --host 0.0.0.0 in ecosystem.config.cjs
```

On remote clients, use the Tailscale hostname:

```json
{
  "mcpServers": {
    "memory": {
      "url": "http://my-machine.tail1234.ts.net:3456/mem-persistence/mcp"
    }
  }
}
```

No API keys, no paths, no wsl. Just the URL.

---

## Embeddings (optional — but recommended)

By default, search uses **token matching only** (Jaccard + containment + entity overlap). No API calls, works offline.

Enabling embeddings adds **semantic understanding**:

| | Token-only | With embeddings |
|---|---|---|
| `"mem-persistence GitHub"` | ✅ finds keyword matches | ✅ higher confidence |
| `"where does Emilio work"` | ❌ no keyword overlap | ✅ understands meaning |
| `"what trips are coming up?"` | ❌ misses if phrased differently | ✅ matches semantically |
| API calls | None | Only for new content (cached after first call) |
| Offline | ✅ always | ✅ after first run |

**Get a free Gemini API key** at [aistudio.google.com](https://aistudio.google.com) → Get API key.

Configure via `ecosystem.config.cjs` (HTTP mode) or env vars (stdio mode):

```bash
MEM_PERSISTENCE_EMBEDDINGS=gemini    # or "openai"
GOOGLE_API_KEY=your-key              # for Gemini (free)
OPENAI_API_KEY=your-key              # for OpenAI ($0.02/M tokens)
```

How it works:
- **Hybrid scoring**: 0.4 × token score + 0.6 × vector score
- **Disk cache**: embeddings stored in `.mem-persistence/embeddings/` — no repeated API calls
- **Default model**: `gemini-embedding-001` (free, 1500 req/min)
- **Fallback**: if the API fails, falls back silently to token-only search

---

## How Dedup Works

Before writing, mem-persistence checks if similar content already exists:

```
Input:  "GitHub configured with gh auth login, user emiliotorrens"
Match:  "gh auth login hecho — cuenta emiliotorrens, protocolo HTTPS"
Result: DUPLICATE (score: 0.90) — not written
```

Uses token similarity (Jaccard + containment) and entity overlap (IDs, dates, versions).

Tune the threshold: `MEM_PERSISTENCE_DEDUP_THRESHOLD=0.65` (default).

---

## Roadmap

- [x] Deduplication engine
- [x] Hybrid search (token + vector + MMR + temporal decay)
- [x] MCP server — stdio and HTTP transports, 6 tools, TypeScript + ESM
- [x] Embedding providers: Gemini (free) and OpenAI, with disk cache
- [x] Request/response logging (`.mem-persistence/logs/`)
- [x] HTTP mode — Tailscale-friendly, pm2-ready
- [ ] CLI (`mem-persistence search "query"`)
- [ ] Local embeddings via transformers.js (offline, no API key)
- [ ] npm publish

## Related

- **[layered-memstack](https://github.com/emiliotorrens/layered-memstack)** — OpenClaw skill that sets up a 3-layer memory system with automated crons, dedup, and knowledge graph. Uses mem-persistence as the MCP bridge.

## Credits

- **[OpenClaw](https://github.com/openclaw/openclaw)** — the agent framework where this was born and battle-tested
- **[MCP](https://modelcontextprotocol.io)** — the protocol that makes cross-agent memory possible

## License

MIT

---

Built with 🐾 by [Emilio Torrens](https://github.com/emiliotorrens) and [Claw](https://github.com/openclaw/openclaw).
