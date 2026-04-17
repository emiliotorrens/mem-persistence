# Memory Instructions for AI Agents

> Copy the relevant section to your agent's instruction file:
> - Claude Code → `CLAUDE.md`
> - Cursor → `.cursorrules`
> - Windsurf → `.windsurfrules`

---

## Instructions (copy below this line)

You have access to a persistent memory system via MCP tools. Use it proactively:

### Before answering questions about context, people, projects, or prior decisions:
- Call `memory_search` with relevant keywords
- Check results from all layers (L1 core facts, L2 topic notes, L3 deep references)

### When you learn something important during a session:
- Call `memory_write` to save decisions, preferences, or facts to the appropriate file
- Use `path: "MEMORY.md"` for core facts (dedup is automatic)
- Use `path: "memory/YYYY-MM-DD.md"` for daily session notes (append: true)
- Use `path: "memory/{topic}.md"` for topic-specific notes

### When starting a new session or task:
- Call `memory_status` to see the current state of memory
- Call `memory_read` with `path: "BOOTSTRAP.md"` for a compiled snapshot of recent context (replaces reading MEMORY.md + daily notes separately). Falls back to `path: "MEMORY.md"` if BOOTSTRAP.md doesn't exist.
- Call `memory_search` with keywords related to the current task

### When ending a long session:
- Call `memory_checkpoint` to save important context from this session

### Knowledge graph:
- Call `memory_entities` to look up people, projects, places, and their relationships
- Update entities when you discover new connections

### Rules:
- Always search before writing to avoid duplicates
- Keep MEMORY.md entries atomic (one fact per line)
- Use TTL comments for time-bound items: `<!-- ttl:YYYY-MM-DD -->`
- Daily notes go in `memory/YYYY-MM-DD.md`
- Topic files go in `memory/{topic}.md`
- Deep references go in `reference/{name}.md`
