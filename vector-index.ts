// A small, dependency-free vector index for RAG demos — feature-hashing
// embeddings (no external embedding API call, no vocabulary to train)
// plus cosine-similarity search. Real technique (the "hashing trick"),
// just not a learned one — good enough to prove the retrieval mechanics
// end-to-end without wiring up a live embedding model. Swap embed() for a
// real one and VectorIndex works unchanged: same seam as ContextClip's
// Summarizer or ActAuth's Approver — a working default the rest of the
// pipeline can be built and tested against.
// Higher dimensions mean fewer hash collisions between unrelated tokens,
// which matters more here than with a learned embedding since there's no
// training to smooth collisions out — 1024 keeps ranking stable for the
// short, few-dozen-document corpora this is meant for.
const EMBEDDING_DIMENSIONS = 1024

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

function normalize(vector: Float64Array): Float64Array {
  let magnitude = 0
  for (const value of vector) magnitude += value * value
  magnitude = Math.sqrt(magnitude)
  if (magnitude === 0) return vector
  const result = new Float64Array(vector.length)
  for (let i = 0; i < vector.length; i++) result[i] = vector[i] / magnitude
  return result
}

/** Hashes each token into one of EMBEDDING_DIMENSIONS buckets (FNV-1a),
 * with the hash's sign deciding +1/-1 to reduce collision bias, then
 * L2-normalizes. Works on tokens it's never seen and needs no training
 * step, at the cost of real embedding quality — a stand-in, not a
 * production embedding model. */
export function embed(text: string): Float64Array {
  const vector = new Float64Array(EMBEDDING_DIMENSIONS)
  for (const token of tokenize(text)) {
    let hash = 2166136261 // FNV offset basis
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i)
      hash = Math.imul(hash, 16777619) // FNV prime
    }
    const bucket = Math.abs(hash) % EMBEDDING_DIMENSIONS
    const sign = hash & 1 ? 1 : -1
    vector[bucket] += sign
  }
  return normalize(vector)
}

/** Both inputs are unit vectors (embed() normalizes), so the dot product
 * already is the cosine similarity. */
export function cosineSimilarity(a: Float64Array, b: Float64Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

export interface Document {
  id: string
  text: string
}

export interface ScoredDocument extends Document {
  score: number
}

/** In-memory vector store: add() embeds and keeps the document, search()
 * returns the top-k most similar by cosine similarity. Swap for a real
 * vector DB (pgvector, Pinecone, ...) once the corpus outgrows memory —
 * same shape, so callers (like a search_docs tool) don't need to change. */
export class VectorIndex {
  private readonly documents: Array<Document & { vector: Float64Array }> = []

  add(id: string, text: string): void {
    this.documents.push({ id, text, vector: embed(text) })
  }

  search(query: string, topK = 3): ScoredDocument[] {
    const queryVector = embed(query)
    return this.documents
      .map(({ id, text, vector }) => ({ id, text, score: cosineSimilarity(queryVector, vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
  }
}
