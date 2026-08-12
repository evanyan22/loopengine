// The one ReAct loop every agent runs through, and every channel adapter
// (CLI, HTTP, ...) calls unchanged — only their AgentConfig and modelCall
// differ. runAgent itself does no I/O and holds no state between calls:
// callers own conversation history, which is what lets the same function
// serve a one-shot CLI invocation and a long-lived chat session.
import { Gate, RuleSet, ConsoleApprover, type Scope } from 'actauth'
import { SkillGarden } from 'skillgarden'
import { ContextClipper, type Message } from 'contextclip'
import { ToolLane, type ToolCall as LaneCall } from 'toollane'
import { Reflow } from 'reflowkit'
import type { AgentConfig, ToolSchema } from './agent-config.js'

export interface ModelContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
}

export interface ModelResponse {
  stop_reason: string
  content: ModelContentBlock[]
}

/** Swap the Anthropic SDK in here — this is the only seam a real API call needs. */
export type ModelCall = (messages: Message[], system: string, tools: ToolSchema[]) => Promise<ModelResponse>

export interface RunAgentOptions {
  /** Emitted at each loop step for callers that want visibility (logging, UI, tests). Default: no-op. */
  onEvent?: (event: string, detail: unknown) => void
}

export interface RunAgentResult {
  /** Final assistant text for this turn. */
  text: string
  /** Full conversation so far, including this turn — pass back in as
   * `history` on the next call to continue the conversation. Opaque to
   * the caller: store/transmit it, don't inspect or mutate it. */
  history: Message[]
}

export async function runAgent(
  config: AgentConfig,
  modelCall: ModelCall,
  userMessage: string,
  history: Message[] = [],
  options: RunAgentOptions = {},
): Promise<RunAgentResult> {
  const log = options.onEvent ?? (() => {})
  const scope: Scope = { tenant: 'default', environment: 'production', ...config.scope, agent: config.name }

  const skillGarden = config.skillsDirs?.length
    ? new SkillGarden({ dirs: config.skillsDirs, indexBudgetTokens: config.skillIndexBudgetTokens ?? 200 })
    : null
  const skillIndex = skillGarden?.buildIndex().included ?? []

  const contextClip = new ContextClipper({ budgetTokens: config.contextBudgetTokens ?? 8000, tailMessages: 4 })
  const rules = new RuleSet(config.rules, config.defaultDecision ?? 'ask')
  const gate = new Gate(rules, config.approver ?? new ConsoleApprover())
  const toolLane = new ToolLane({ isSafe: config.isSafeTool ?? (() => false) })
  const reflow = new Reflow<Message[]>({
    onPromptTooLong: async (messages) => {
      const result = await contextClip.recover(messages)
      log('reflow:recover', { from: messages.length, to: result.messages.length })
      return result.messages
    },
  })

  // Optional on AgentConfig — an MCP-only agent's tools are populated by
  // load-agent.ts before this ever runs, but default defensively here too
  // in case a config reaches runAgent without going through it.
  const tools = config.tools ?? []
  const toolsByName = new Map(tools.map((t) => [t.name, t]))
  const toolSchemas: ToolSchema[] = tools.map(({ name, description, input_schema }) => ({
    name,
    description,
    input_schema,
  }))

  const systemPrompt = skillIndex.length
    ? `${config.systemPrompt}\n\nAvailable skills:\n${skillIndex.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`
    : config.systemPrompt

  let messages: Message[] = [...history, { role: 'user', content: userMessage }]

  for (;;) {
    const budget = contextClip.check(messages)
    log('contextclip:check', budget)
    if (budget.action === 'nudge' && budget.nudge) messages.push(budget.nudge)

    const { value: response, recoveries } = await reflow.call(
      (msgs) => modelCall(msgs, systemPrompt, toolSchemas),
      messages,
    )
    if (recoveries.length > 0) log('reflow:recoveries', recoveries)

    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use')

    if (toolUseBlocks.length === 0) {
      const text = response.content.find((b) => b.type === 'text')?.text ?? ''
      log('loop:done', text)
      messages.push({ role: 'assistant', content: text })
      return { text, history: messages }
    }

    // Skill invocation injects instructions into context; it isn't a tool
    // that needs ActAuth gating or ToolLane scheduling.
    const skillCall = toolUseBlocks.find((b) => b.name === 'Skill')
    if (skillCall && skillGarden) {
      const body = skillGarden.invoke(skillCall.input!.skill as string)
      log('skillgarden:invoke', skillCall.input!.skill)
      messages.push({ role: 'assistant', content: `[called Skill: ${skillCall.input!.skill}]` })
      messages.push({ role: 'user', content: body })
      continue
    }

    const approved: typeof toolUseBlocks = []
    for (const block of toolUseBlocks) {
      const decision = await gate.evaluate(block.name!, block.input ?? {}, scope)
      log('actauth:decision', { tool: block.name, decision: decision.decision, reason: decision.reason })
      if (decision.decision === 'allow') approved.push(block)
    }

    messages.push({ role: 'assistant', content: `[requested: ${toolUseBlocks.map((b) => b.name).join(', ')}]` })

    const calls: LaneCall[] = approved.map((b) => ({
      id: b.id!,
      name: b.name!,
      execute: () => toolsByName.get(b.name!)!.execute(b.input ?? {}),
    }))
    for await (const result of toolLane.run(calls)) {
      const summary = result.status === 'fulfilled' ? JSON.stringify(result.value) : `ERROR: ${result.error}`
      log('toollane:result', { name: result.name, summary })
      messages.push({ role: 'user', content: `[${result.name} result] ${summary}` })
    }
  }
}
