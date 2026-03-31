/**
 * embeddings.ts — Embedding providers for semantic search
 *
 * Supports: gemini, openai, local (transformers.js), none
 * Embeddings are cached to .mem-persistence/embeddings/
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { createHash } from "crypto";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EmbeddingProvider {
  name: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingConfig {
  provider: "none" | "gemini" | "openai" | "local";
  apiKey?: string;
  model?: string;
  cacheDir?: string;
}

export interface CachedEmbedding {
  text: string;
  vector: number[];
  model: string;
  timestamp: number;
}

// ─── Cache ──────────────────────────────────────────────────────────────────

const memoryCache = new Map<string, number[]>();

function cacheKey(text: string, model: string): string {
  const hash = createHash("sha256")
    .update(`${model}:${text}`)
    .digest("hex")
    .slice(0, 16);
  return hash;
}

async function getCached(
  text: string,
  model: string,
  cacheDir: string
): Promise<number[] | null> {
  const key = cacheKey(text, model);

  // Memory cache first
  if (memoryCache.has(key)) return memoryCache.get(key)!;

  // Disk cache
  const file = join(cacheDir, `${key}.json`);
  if (existsSync(file)) {
    try {
      const data: CachedEmbedding = JSON.parse(
        await readFile(file, "utf8")
      );
      memoryCache.set(key, data.vector);
      return data.vector;
    } catch {
      return null;
    }
  }
  return null;
}

async function setCache(
  text: string,
  vector: number[],
  model: string,
  cacheDir: string
): Promise<void> {
  const key = cacheKey(text, model);
  memoryCache.set(key, vector);

  if (!existsSync(cacheDir)) {
    await mkdir(cacheDir, { recursive: true });
  }

  const data: CachedEmbedding = {
    text: text.slice(0, 200), // truncate for readability
    vector,
    model,
    timestamp: Date.now(),
  };

  const file = join(cacheDir, `${key}.json`);
  await writeFile(file, JSON.stringify(data)).catch(() => {});
}

// ─── Gemini Provider ────────────────────────────────────────────────────────

function createGeminiProvider(
  apiKey: string,
  model = "gemini-embedding-001"
): EmbeddingProvider {
  return {
    name: `gemini/${model}`,
    dimensions: 768,
    async embed(texts: string[]): Promise<number[][]> {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${apiKey}`;

      const requests = texts.map((text) => ({
        model: `models/${model}`,
        content: { parts: [{ text }] },
      }));

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requests }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Gemini embedding error ${response.status}: ${err}`);
      }

      const data = (await response.json()) as {
        embeddings: { values: number[] }[];
      };
      return data.embeddings.map((e) => e.values);
    },
  };
}

// ─── OpenAI Provider ────────────────────────────────────────────────────────

function createOpenAIProvider(
  apiKey: string,
  model = "text-embedding-3-small"
): EmbeddingProvider {
  return {
    name: `openai/${model}`,
    dimensions: model.includes("3-small") ? 1536 : 3072,
    async embed(texts: string[]): Promise<number[][]> {
      const response = await fetch(
        "https://api.openai.com/v1/embeddings",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ input: texts, model }),
        }
      );

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`OpenAI embedding error ${response.status}: ${err}`);
      }

      const data = (await response.json()) as {
        data: { embedding: number[] }[];
      };
      return data.data.map((d) => d.embedding);
    },
  };
}

// ─── Vector math ────────────────────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ─── Main interface ─────────────────────────────────────────────────────────

export class EmbeddingService {
  private provider: EmbeddingProvider | null = null;
  private cacheDir: string;
  private modelName: string;

  constructor(config: EmbeddingConfig, workspace: string) {
    this.cacheDir =
      config.cacheDir || join(workspace, ".mem-persistence", "embeddings");
    this.modelName = "none";

    if (config.provider === "gemini" && config.apiKey) {
      this.provider = createGeminiProvider(config.apiKey, config.model);
      this.modelName = this.provider.name;
    } else if (config.provider === "openai" && config.apiKey) {
      this.provider = createOpenAIProvider(config.apiKey, config.model);
      this.modelName = this.provider.name;
    }
    // "local" and "none" → no provider (local via transformers.js is Phase 2b)
  }

  get enabled(): boolean {
    return this.provider !== null;
  }

  get name(): string {
    return this.modelName;
  }

  /**
   * Get embeddings for texts, using cache when available.
   * Returns null if embeddings are disabled.
   */
  async embed(texts: string[]): Promise<number[][] | null> {
    if (!this.provider) return null;

    const results: number[][] = new Array(texts.length);
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];

    // Check cache
    for (let i = 0; i < texts.length; i++) {
      const cached = await getCached(texts[i], this.modelName, this.cacheDir);
      if (cached) {
        results[i] = cached;
      } else {
        uncachedIndices.push(i);
        uncachedTexts.push(texts[i]);
      }
    }

    // Batch embed uncached
    if (uncachedTexts.length > 0) {
      // Batch in chunks of 100
      const batchSize = 100;
      for (let b = 0; b < uncachedTexts.length; b += batchSize) {
        const batch = uncachedTexts.slice(b, b + batchSize);
        const vectors = await this.provider.embed(batch);

        for (let j = 0; j < vectors.length; j++) {
          const idx = uncachedIndices[b + j];
          results[idx] = vectors[j];
          await setCache(
            texts[idx],
            vectors[j],
            this.modelName,
            this.cacheDir
          );
        }
      }
    }

    return results;
  }

  /**
   * Get embedding for a single text.
   */
  async embedOne(text: string): Promise<number[] | null> {
    const results = await this.embed([text]);
    return results ? results[0] : null;
  }

  /**
   * Compute similarity between query and candidate texts.
   * Returns scores array (0-1) or null if disabled.
   */
  async similarity(
    query: string,
    candidates: string[]
  ): Promise<number[] | null> {
    if (!this.provider) return null;

    const queryVec = await this.embedOne(query);
    if (!queryVec) return null;

    const candidateVecs = await this.embed(candidates);
    if (!candidateVecs) return null;

    return candidateVecs.map((vec) => cosineSimilarity(queryVec, vec));
  }
}
