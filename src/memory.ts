/**
 * memory.ts — Core memory layer: read, search, write, dedup
 *
 * All operations work on plain markdown files in the workspace.
 */

import { readdir, readFile, writeFile, stat, mkdir, rename } from "fs/promises";
import { join, relative, extname, basename } from "path";
import { existsSync } from "fs";
import { EmbeddingService, type EmbeddingConfig } from "./embeddings.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MemoryConfig {
  workspace: string;
  memoryDir: string; // default: "memory"
  referenceDir: string; // default: "reference"
  coreFile: string; // default: "MEMORY.md"
  entitiesFile: string; // default: "reference/entities.md"
  archiveDir: string; // default: "memory/archive"
  dedupThreshold: number; // default: 0.65
  embeddings: EmbeddingConfig; // default: { provider: "none" }
}

export interface SearchResult {
  path: string;
  relativePath: string;
  line: number;
  text: string;
  score: number;
  layer: "L1" | "L2" | "L3";
}

export interface MemoryStatus {
  workspace: string;
  coreFile: { exists: boolean; lines: number; sizeBytes: number };
  memoryDir: { files: number; totalLines: number };
  referenceDir: { files: number; totalLines: number };
  entitiesFile: { exists: boolean; sections: number };
  lastDailyNote: string | null;
}

export interface DedupResult {
  isDuplicate: boolean;
  score: number;
  reason: string;
  match: string | null;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

export function defaultConfig(workspace: string): MemoryConfig {
  return {
    workspace,
    memoryDir: "memory",
    referenceDir: "reference",
    coreFile: "MEMORY.md",
    entitiesFile: "reference/entities.md",
    archiveDir: "memory/archive",
    dedupThreshold: 0.65,
    embeddings: { provider: "none" },
  };
}

// ─── File helpers ───────────────────────────────────────────────────────────

async function listMdFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMdFiles(full)));
    } else if (extname(entry.name) === ".md") {
      files.push(full);
    }
  }
  return files;
}

async function readLines(filePath: string): Promise<string[]> {
  if (!existsSync(filePath)) return [];
  const content = await readFile(filePath, "utf8");
  return content.split("\n");
}

function getLayer(
  filePath: string,
  config: MemoryConfig
): "L1" | "L2" | "L3" {
  const rel = relative(config.workspace, filePath);
  if (rel === config.coreFile || rel === "USER.md" || rel === "IDENTITY.md")
    return "L1";
  if (rel.startsWith(config.memoryDir + "/")) return "L2";
  return "L3";
}

// ─── Tokenization & Similarity (port of memory-dedup.js) ───────────────────

function normalize(line: string): string {
  return line
    .replace(/<!--.*?-->/g, "")
    .replace(/\*\*/g, "")
    .replace(/[`_~]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/#{1,6}\s*/g, "")
    .replace(/[-*]\s+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function tokenize(text: string): string[] {
  return normalize(text)
    .split(/[^a-záéíóúñüà-ÿ0-9]+/i)
    .filter((t) => t.length > 1);
}

function jaccardSimilarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const x of setA) if (setB.has(x)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

function containsSimilarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const longerSet = new Set(longer);
  const overlap = shorter.filter((t) => longerSet.has(t)).length;
  return overlap / shorter.length;
}

function extractEntities(text: string): Set<string> {
  const entities = new Set<string>();
  const clean = text.replace(/<!--.*?-->/g, "").replace(/\*\*/g, "");
  for (const m of clean.matchAll(/\d{4}[-/]\d{2}[-/]\d{2}/g))
    entities.add(m[0]);
  for (const m of clean.matchAll(/v?\d+\.\d+[\.\d]*/g))
    entities.add(m[0].toLowerCase());
  for (const m of clean.matchAll(/\b[a-f0-9]{6,}\b/gi))
    entities.add(m[0].toLowerCase());
  for (const m of clean.matchAll(/\+\d[\d\s]{8,}/g))
    entities.add(m[0].replace(/\s/g, ""));
  for (const m of clean.matchAll(/\d+[\.,]?\d*\s*€/g))
    entities.add(m[0].replace(/\s/g, ""));
  for (const m of clean.matchAll(/-\d{10,}/g)) entities.add(m[0]);
  return entities;
}

function entityOverlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  return intersection / Math.min(a.size, b.size);
}

function similarity(
  lineA: string,
  lineB: string
): { score: number; reason: string } {
  const normA = normalize(lineA);
  const normB = normalize(lineB);
  if (normA === normB) return { score: 1.0, reason: "exact" };
  if (normA.length < 10 || normB.length < 10)
    return { score: 0, reason: "too-short" };

  const tokA = tokenize(lineA);
  const tokB = tokenize(lineB);
  const jaccard = jaccardSimilarity(tokA, tokB);
  const containment = containsSimilarity(tokA, tokB);

  const entA = extractEntities(lineA);
  const entB = extractEntities(lineB);
  const entOvl = entityOverlap(entA, entB);

  const hasEntities = entA.size > 0 || entB.size > 0;
  const score = hasEntities
    ? jaccard * 0.3 + containment * 0.4 + entOvl * 0.3
    : jaccard * 0.4 + containment * 0.6;

  let reason = "semantic";
  if (jaccard > 0.9) reason = "near-exact";
  else if (containment > 0.9) reason = "subset";
  else if (entOvl > 0.8 && jaccard > 0.5) reason = "same-entities";

  return { score, reason };
}

// ─── Core Operations ────────────────────────────────────────────────────────

/**
 * Search across all memory layers.
 * Returns results sorted by score (descending), with temporal decay for daily notes.
 */
export async function search(
  query: string,
  config: MemoryConfig,
  options: { maxResults?: number; layers?: ("L1" | "L2" | "L3")[] } = {}
): Promise<SearchResult[]> {
  const maxResults = options.maxResults ?? 20;
  const layers = options.layers ?? ["L1", "L2", "L3"];

  // Gather all md files
  const allFiles: string[] = [];
  const coreFilePath = join(config.workspace, config.coreFile);
  if (existsSync(coreFilePath)) allFiles.push(coreFilePath);

  // User/identity files
  for (const f of ["USER.md", "IDENTITY.md"]) {
    const p = join(config.workspace, f);
    if (existsSync(p)) allFiles.push(p);
  }

  // Memory dir
  const memDir = join(config.workspace, config.memoryDir);
  allFiles.push(...(await listMdFiles(memDir)));

  // Reference dir
  const refDir = join(config.workspace, config.referenceDir);
  allFiles.push(...(await listMdFiles(refDir)));

  const queryTokens = tokenize(query);
  const queryEntities = extractEntities(query);
  const now = Date.now();

  // Collect all candidate lines
  interface Candidate {
    path: string;
    relativePath: string;
    line: number;
    text: string;
    layer: "L1" | "L2" | "L3";
    tokenScore: number;
  }

  const candidates: Candidate[] = [];

  for (const filePath of allFiles) {
    const layer = getLayer(filePath, config);
    if (!layers.includes(layer)) continue;

    const lines = await readLines(filePath);
    const rel = relative(config.workspace, filePath);

    // Temporal decay for daily notes (YYYY-MM-DD.md)
    let temporalMultiplier = 1.0;
    const dateMatch = basename(filePath).match(/^(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      const fileDate = new Date(dateMatch[1]).getTime();
      const daysDiff = (now - fileDate) / (1000 * 60 * 60 * 24);
      const halfLife = 30; // days
      temporalMultiplier = Math.pow(0.5, daysDiff / halfLife);
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim() || /^#{1,6}\s/.test(line)) continue;

      // Skip JSON metadata, very short lines, and code block markers
      const trimmed = line.trim();
      if (trimmed.startsWith('```') || trimmed.startsWith('{') || trimmed.startsWith('}')) continue;
      if (/^"[^"]+"\s*:\s*"[^"]*",?$/.test(trimmed)) continue; // JSON key-value
      if (/^[\[\]{}],?$/.test(trimmed)) continue; // JSON brackets

      const lineTokens = tokenize(line);
      if (lineTokens.length < 3) continue; // Require at least 3 meaningful tokens

      const jaccard = jaccardSimilarity(queryTokens, lineTokens);
      const containment = containsSimilarity(queryTokens, lineTokens);
      const lineEntities = extractEntities(line);
      const entOvl = entityOverlap(queryEntities, lineEntities);

      let tokenScore =
        queryEntities.size > 0
          ? jaccard * 0.3 + containment * 0.4 + entOvl * 0.3
          : jaccard * 0.4 + containment * 0.6;

      tokenScore *= temporalMultiplier;

      // Boost L1 slightly
      if (layer === "L1") tokenScore *= 1.1;

      if (tokenScore > 0.05) {  // Lower threshold when embeddings enabled; filtered later
        candidates.push({
          path: filePath,
          relativePath: rel,
          line: i + 1,
          text: line.trim(),
          layer,
          tokenScore,
        });
      }
    }
  }

  // If embeddings are enabled, compute hybrid scores
  const embeddingService = new EmbeddingService(config.embeddings, config.workspace);

  if (embeddingService.enabled && candidates.length > 0) {
    // Get top candidates by token score for embedding (limit to save API calls)
    const topK = Math.min(candidates.length, maxResults * 3);
    candidates.sort((a, b) => b.tokenScore - a.tokenScore);
    const topCandidates = candidates.slice(0, topK);

    const vectorScores = await embeddingService.similarity(
      query,
      topCandidates.map((c) => c.text)
    );

    if (vectorScores) {
      // Hybrid score: 0.4 token + 0.6 vector
      // But require minimum token relevance to avoid pure name matches
      const results: SearchResult[] = topCandidates
        .map((c, i) => ({
          path: c.path,
          relativePath: c.relativePath,
          line: c.line,
          text: c.text,
          score: Math.round((c.tokenScore * 0.4 + vectorScores[i] * 0.6) * 1000) / 1000,
          layer: c.layer,
        }))
        .filter((r) => r.score > 0.25);

      results.sort((a, b) => b.score - a.score);

      // MMR-style diversity: penalize results from same file+nearby lines
      const diverse: SearchResult[] = [];
      for (const r of results) {
        const isDuplicate = diverse.some(
          (d) =>
            d.relativePath === r.relativePath &&
            Math.abs(d.line - r.line) < 5
        );
        if (!isDuplicate) diverse.push(r);
        if (diverse.length >= maxResults) break;
      }

      return diverse;
    }
  }

  // Fallback: token-only scoring
  const results: SearchResult[] = candidates
    .filter((c) => c.tokenScore > 0.15)
    .map((c) => ({
      path: c.path,
      relativePath: c.relativePath,
      line: c.line,
      text: c.text,
      score: Math.round(c.tokenScore * 1000) / 1000,
      layer: c.layer,
    }));

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, maxResults);
}

/**
 * Read a specific memory file.
 */
export async function read(
  filePath: string,
  config: MemoryConfig,
  options: { startLine?: number; endLine?: number } = {}
): Promise<{ content: string; lines: number; layer: "L1" | "L2" | "L3" }> {
  const fullPath = filePath.startsWith("/")
    ? filePath
    : join(config.workspace, filePath);

  if (!existsSync(fullPath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  // Security: ensure within workspace
  const resolved = join(config.workspace, relative(config.workspace, fullPath));
  if (!resolved.startsWith(config.workspace)) {
    throw new Error(`Access denied: path outside workspace`);
  }

  const allLines = await readLines(fullPath);
  const start = (options.startLine ?? 1) - 1;
  const end = options.endLine ?? allLines.length;
  const content = allLines.slice(start, end).join("\n");

  return {
    content,
    lines: allLines.length,
    layer: getLayer(fullPath, config),
  };
}

/**
 * Write to a memory file with dedup check.
 * Returns what was written and whether dedup filtered anything.
 */
export async function write(
  filePath: string,
  content: string,
  config: MemoryConfig,
  options: { append?: boolean; dedupCheck?: boolean } = {}
): Promise<{
  written: boolean;
  filtered: string[];
  path: string;
}> {
  const fullPath = filePath.startsWith("/")
    ? filePath
    : join(config.workspace, filePath);

  // Security: ensure within workspace
  const resolved = join(config.workspace, relative(config.workspace, fullPath));
  if (!resolved.startsWith(config.workspace)) {
    throw new Error(`Access denied: path outside workspace`);
  }

  // Ensure directory exists
  const dir = join(fullPath, "..");
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  const lines = content.split("\n").filter((l) => l.trim());
  const filtered: string[] = [];
  let linesToWrite = lines;

  // Dedup check against MEMORY.md if writing to L1
  if (options.dedupCheck !== false) {
    const coreFilePath = join(config.workspace, config.coreFile);
    if (existsSync(coreFilePath)) {
      const coreContent = await readFile(coreFilePath, "utf8");
      linesToWrite = [];
      for (const line of lines) {
        const normLine = normalize(line);
        if (normLine.length < 10) {
          linesToWrite.push(line);
          continue;
        }
        // Check against all existing lines
        const coreLines = coreContent.split("\n");
        let isDup = false;
        for (const existing of coreLines) {
          const sim = similarity(line, existing);
          if (sim.score >= config.dedupThreshold) {
            isDup = true;
            filtered.push(line);
            break;
          }
        }
        if (!isDup) linesToWrite.push(line);
      }
    }
  }

  if (linesToWrite.length === 0) {
    return { written: false, filtered, path: relative(config.workspace, fullPath) };
  }

  const finalContent = linesToWrite.join("\n") + "\n";

  if (options.append && existsSync(fullPath)) {
    const existing = await readFile(fullPath, "utf8");
    await writeFile(fullPath, existing + "\n" + finalContent);
  } else {
    await writeFile(fullPath, finalContent);
  }

  return {
    written: true,
    filtered,
    path: relative(config.workspace, fullPath),
  };
}

/**
 * Save a context checkpoint to today's daily note.
 */
export async function checkpoint(
  content: string,
  config: MemoryConfig
): Promise<{ path: string }> {
  const today = new Date().toISOString().slice(0, 10);
  const fileName = `${today}.md`;
  const filePath = join(config.workspace, config.memoryDir, fileName);
  const time = new Date().toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });

  const section = `\n## Checkpoint ${time}\n${content}\n`;

  if (existsSync(filePath)) {
    const existing = await readFile(filePath, "utf8");
    await writeFile(filePath, existing + section);
  } else {
    const header = `# ${today}\n${section}`;
    await writeFile(filePath, header);
  }

  return { path: relative(config.workspace, filePath) };
}

/**
 * Read or update the knowledge graph (entities.md).
 */
export async function entities(
  config: MemoryConfig,
  options: { section?: string; update?: string } = {}
): Promise<{ content: string; sections: string[] }> {
  const filePath = join(config.workspace, config.entitiesFile);

  if (!existsSync(filePath)) {
    return { content: "(entities.md not found)", sections: [] };
  }

  const content = await readFile(filePath, "utf8");
  const sections = [...content.matchAll(/^## (.+)$/gm)].map((m) => m[1]);

  if (options.update && options.section) {
    // Append to a specific section
    const sectionHeader = `## ${options.section}`;
    const idx = content.indexOf(sectionHeader);
    if (idx >= 0) {
      // Find end of section (next ## or EOF)
      const rest = content.slice(idx + sectionHeader.length);
      const nextSection = rest.search(/\n## /);
      const insertAt =
        nextSection >= 0
          ? idx + sectionHeader.length + nextSection
          : content.length;

      const updated =
        content.slice(0, insertAt) +
        "\n" +
        options.update +
        "\n" +
        content.slice(insertAt);
      await writeFile(filePath, updated);
      return {
        content: updated,
        sections,
      };
    }
  }

  // If section filter, return only that section
  if (options.section) {
    const sectionHeader = `## ${options.section}`;
    const idx = content.indexOf(sectionHeader);
    if (idx >= 0) {
      const rest = content.slice(idx);
      const nextSection = rest.indexOf("\n## ", 1);
      const sectionContent =
        nextSection >= 0 ? rest.slice(0, nextSection) : rest;
      return { content: sectionContent, sections };
    }
    return { content: `(section "${options.section}" not found)`, sections };
  }

  return { content, sections };
}

/**
 * Get memory system status.
 */
export async function status(config: MemoryConfig): Promise<MemoryStatus> {
  const coreFilePath = join(config.workspace, config.coreFile);
  let coreInfo = { exists: false, lines: 0, sizeBytes: 0 };
  if (existsSync(coreFilePath)) {
    const lines = await readLines(coreFilePath);
    const stats = await stat(coreFilePath);
    coreInfo = { exists: true, lines: lines.length, sizeBytes: stats.size };
  }

  const memDir = join(config.workspace, config.memoryDir);
  const memFiles = await listMdFiles(memDir);
  let memLines = 0;
  for (const f of memFiles) {
    memLines += (await readLines(f)).length;
  }

  const refDir = join(config.workspace, config.referenceDir);
  const refFiles = await listMdFiles(refDir);
  let refLines = 0;
  for (const f of refFiles) {
    refLines += (await readLines(f)).length;
  }

  const entPath = join(config.workspace, config.entitiesFile);
  let entSections = 0;
  if (existsSync(entPath)) {
    const content = await readFile(entPath, "utf8");
    entSections = [...content.matchAll(/^## /gm)].length;
  }

  // Find latest daily note
  let lastDaily: string | null = null;
  const dailyPattern = /^\d{4}-\d{2}-\d{2}\.md$/;
  if (existsSync(memDir)) {
    const entries = await readdir(memDir);
    const dailies = entries
      .filter((e) => dailyPattern.test(e))
      .sort()
      .reverse();
    if (dailies.length) lastDaily = dailies[0].replace(".md", "");
  }

  return {
    workspace: config.workspace,
    coreFile: coreInfo,
    memoryDir: { files: memFiles.length, totalLines: memLines },
    referenceDir: { files: refFiles.length, totalLines: refLines },
    entitiesFile: { exists: existsSync(entPath), sections: entSections },
    lastDailyNote: lastDaily,
  };
}
