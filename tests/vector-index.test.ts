import { describe, expect, it } from 'vitest'
import { VectorIndex, embed, cosineSimilarity } from '../core/vector-index.js'

describe('embed', () => {
  it('is deterministic', () => {
    expect(embed('hello world')).toEqual(embed('hello world'))
  })

  it('produces a unit vector', () => {
    const vector = embed('a reasonably long sentence with several distinct words in it')
    let magnitude = 0
    for (const value of vector) magnitude += value * value
    expect(Math.sqrt(magnitude)).toBeCloseTo(1, 5)
  })

  it('is order-insensitive (bag of words)', () => {
    expect(embed('quick brown fox')).toEqual(embed('fox quick brown'))
  })

  it('returns an all-zero vector for text with no tokens', () => {
    const vector = embed('   !!! ---   ')
    expect([...vector].every((v) => v === 0)).toBe(true)
  })
})

describe('cosineSimilarity', () => {
  it('is 1 for identical embeddings', () => {
    const a = embed('the audit log records every decision')
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 10)
  })

  it('is higher for texts sharing more vocabulary', () => {
    const query = embed('audit log decisions')
    const close = embed('the audit log records every decision')
    const far = embed('completely unrelated text about weather patterns')
    expect(cosineSimilarity(query, close)).toBeGreaterThan(cosineSimilarity(query, far))
  })
})

describe('VectorIndex', () => {
  it('ranks the most relevant document first', () => {
    const index = new VectorIndex()
    index.add('audit', 'Every decision writes to an append-only audit log for compliance.')
    index.add('weather', 'Q1 revenue grew due to favorable seasonal weather patterns.')
    index.add('scheduling', 'Tool calls are scheduled into parallel or solo lanes.')

    const results = index.search('how are decisions logged for audit purposes')

    expect(results[0].id).toBe('audit')
  })

  it('respects topK', () => {
    const index = new VectorIndex()
    for (let i = 0; i < 10; i++) index.add(`doc-${i}`, `document number ${i} about testing`)

    expect(index.search('testing document', 3)).toHaveLength(3)
  })

  it('returns an empty array when the index is empty', () => {
    const index = new VectorIndex()
    expect(index.search('anything')).toEqual([])
  })

  it('includes the original text and a score alongside each hit', () => {
    const index = new VectorIndex()
    index.add('doc-1', 'a document about vector search')

    const [hit] = index.search('vector search')

    expect(hit.id).toBe('doc-1')
    expect(hit.text).toBe('a document about vector search')
    expect(hit.score).toBeGreaterThan(0)
  })
})
