// A fourth example agent — same runAgent loop as file-agent.ts and
// friends, but its one tool retrieves from an in-memory knowledge base
// instead of the filesystem. Proves RAG needs no changes to run-agent.ts
// at all: search_docs is an ordinary ToolDefinition (agent-config.ts),
// gated by ActAuth and scheduled by ToolLane exactly like read_file is in
// file-agent.ts. The model decides when to call it; run-agent.ts doesn't
// know or care that "executing" this particular tool means a vector
// search instead of a filesystem read or an MCP round-trip.
import type { AgentConfig } from '../agent-config.js'
import { runAgent, type ModelCall } from '../run-agent.js'
import { VectorIndex } from '../vector-index.js'

// A tiny knowledge base — short excerpts from the sibling libraries'
// READMEs, standing in for "your real document corpus." Swap the source
// (a directory of docs chunked at load time, a database, a real vector
// DB client) and search_docs works unchanged; the tool's shape is the
// whole seam, same as ContextClip's Summarizer or ActAuth's Approver.
const KNOWLEDGE_BASE: Array<{ id: string; text: string }> = [
  {
    id: 'actauth',
    text: 'ActAuth is a self-hosted policy gate for AI agent tool calls. A declarative rule set decides allow, ask, or deny per call, and ask routes to a human approver who must approve or deny before the tool runs. Every decision writes to an append-only audit log.',
  },
  {
    id: 'contextclip',
    text: 'ContextClip is a budget tracker and compaction engine for agent conversation history. It checks token usage against a soft and hard threshold, and recovers on overflow by draining old messages before falling back to summarization, always preserving the most recent tail messages untouched.',
  },
  {
    id: 'reflow',
    text: 'Reflow wraps a model API call with reactive recovery: it compacts and retries when a prompt is too long, strips and retries when media is oversized, and retries with recovery when a response comes back truncated.',
  },
  {
    id: 'sessionknit',
    text: 'SessionKnit is durable, DAG-shaped session persistence. It repairs topology for parallel tool-call siblings on resume and detects when a session was interrupted mid-turn, injecting a synthetic continuation message so the resent history is valid.',
  },
  {
    id: 'skillgarden',
    text: 'SkillGarden is an index-now-load-later runtime for agent skills. A lightweight name and description index loads at startup within a token budget, and the full skill body loads lazily only when the skill is actually invoked.',
  },
  {
    id: 'toollane',
    text: 'ToolLane schedules a batch of already-approved tool calls into lanes: consecutive calls declared safe run together in a parallel lane, and anything else gets its own solo lane, with batch order preserved and one failure isolated to its own slot.',
  },
]

const index = new VectorIndex()
for (const doc of KNOWLEDGE_BASE) index.add(doc.id, doc.text)

export const config: AgentConfig = {
  name: 'rag-agent',
  systemPrompt:
    'You answer questions about the loopengine sibling libraries using search_docs — never answer from memory alone.',
  tools: [
    {
      name: 'search_docs',
      description: 'Search the knowledge base for passages relevant to a query',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      execute: async (input) => {
        const hits = index.search(input.query as string, 2)
        return hits.map((h) => `[${h.id}] ${h.text}`).join('\n\n')
      },
    },
  ],
  rules: [{ scopePattern: 'default/production/rag-agent', tool: 'search_docs', decision: 'allow' }],
  defaultDecision: 'ask',
  isSafeTool: (call) => call.name === 'search_docs', // read-only, safe to parallelize
}

// SIMULATED model call — see file-agent.ts for why this is a factory.
// The retrieval itself is real (VectorIndex.search runs for real); only
// which query the model decides to ask is canned.
export function createModelCall(): ModelCall {
  let turn = 0
  return async () => {
    turn++
    if (turn === 1) {
      return {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'search_docs',
            input: { query: 'how does the audit log record human approval decisions' },
          },
        ],
      }
    }
    return {
      stop_reason: 'end_turn',
      content: [
        {
          type: 'text',
          text: 'ActAuth writes every decision — automatic or human — to an append-only audit log, including approvals routed through a human approver.',
        },
      ],
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAgent(config, createModelCall(), 'How does ActAuth record human approval decisions?', [], {
    onEvent: (event, detail) => console.log(`[${event}]`, detail),
  }).then((result) => console.log('\n[final]', result.text))
}
