// Wraps a whole agent — its own system prompt, tools, permission rules,
// and ReAct loop — as a single ToolDefinition another agent can call.
// The calling agent only ever sees a request in, a final answer out: the
// wrapped agent's own turns, tool calls, and permission decisions never
// surface to it. See run-agent.ts's loadSubagentAsTools for the
// convention-over-configuration layer built on top of this (an
// agents/<name>/subagents/<child>/ folder auto-wraps `child` with this
// and merges it into `name`'s tools — most callers want that, not this
// function directly).
import type { AgentConfig, ToolDefinition } from '#core/agent-config.js'
import { runAgent, type ModelCall } from '#core/run-agent.js'

/** `createModelCall` is a factory, not a shared instance — the same
 * `AgentModule.createModelCall` contract discover-agents.ts already
 * uses, so each call to the returned tool gets its own ModelCall rather
 * than sharing one across concurrent invocations. */
export function agentAsTool(config: AgentConfig, createModelCall: () => ModelCall): ToolDefinition {
  if (!config.toolDescription) {
    throw new Error(
      `agentAsTool('${config.name}') requires AgentConfig.toolDescription — see its own doc comment. ` +
        `systemPrompt is instructions for '${config.name}' itself, not a description a caller can use to decide when to invoke it.`,
    )
  }

  return {
    name: config.name,
    description: config.toolDescription,
    input_schema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'What to ask this agent to do.' },
      },
      required: ['request'],
    },
    // Deliberately no `safe: true` here: this agent may itself call
    // unsafe tools, and agentAsTool has no way to know that from the
    // outside — declaring it safe would be a claim about side effects
    // this function isn't in a position to make. Callers that know their
    // specific subagent is read-only can still set `safe: true` on the
    // returned object themselves.
    execute: async (input) => {
      const result = await runAgent(config, createModelCall(), String(input.request))
      return result.text
    },
  }
}
