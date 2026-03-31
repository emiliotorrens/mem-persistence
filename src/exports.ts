export { createServer } from "./server.js";
export { defaultConfig } from "./memory.js";
export type { MemoryConfig, SearchResult, MemoryStatus, DedupResult } from "./memory.js";
export { EmbeddingService, cosineSimilarity } from "./embeddings.js";
export type { EmbeddingConfig, EmbeddingProvider } from "./embeddings.js";
export * as memory from "./memory.js";
