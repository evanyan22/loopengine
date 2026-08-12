// The declarative surface a user fills in to define a new agent. Nothing
// here runs anything — load-agent.ts resolves mcpServers into real tools,
// and run-agent.ts is the one place that interprets the result.
import type { Rule, Decision, Scope, Approver } from 'actauth'
import type { SafetyClassifier } from 'toollane'
import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'

export interface ToolSchema {
  name: string
  description: string
  /** JSON schema sent to the model so it knows how to call the tool. */
  input_schema: Record<string, unknown>
}

export interface ToolDefinition extends ToolSchema {
  execute: (input: Record<string, unknown>) => Promise<unknown>
}

export interface AgentConfig {
  /** Also doubles as the ActAuth scope.agent segment. */
  name: string
  systemPrompt: string
  /** Hand-written tools. Default []  — an agent can run on mcpServers alone. */
  tools?: ToolDefinition[]
  /** MCP servers to connect at load time (see load-agent.ts); their
   * tools are discovered via listTools() and appended to `tools`. This
   * is what makes adding an MCP-backed agent a config change — write
   * rules for the tool names you expect it to expose (check its docs, or
   * probe it once), same as for a hand-written tool. Anything it exposes
   * that you didn't write a rule for still safely falls through to
   * defaultDecision. */
  mcpServers?: StdioServerParameters[]
  /** ActAuth rules, e.g. { scopePattern: 'default/production/customer-service', tool: 'issue_refund', decision: 'ask' } */
  rules: Rule[]
  /** Decision when no rule matches. Default 'ask' — new tools are opt-in, not silently allowed. */
  defaultDecision?: Decision
  /** Default ConsoleApprover (blocks on stdin) — pass e.g. a Slack-backed Approver for unattended agents. */
  approver?: Approver
  scope?: Partial<Omit<Scope, 'agent'>>
  /** SKILL.md directories this agent can discover and invoke. Omit if the agent has no skills. */
  skillsDirs?: string[]
  skillIndexBudgetTokens?: number
  contextBudgetTokens?: number
  /** Which tools ToolLane may run in a parallel lane. Default: none (every tool runs solo). */
  isSafeTool?: SafetyClassifier
  /** How adapters/http.ts derives a session key from a request body — this
   * is business logic ("what counts as one conversation" is agent-
   * specific: a customer, a Slack channel, a ticket, ...), not a channel-
   * adapter concern, so it lives here rather than being hardcoded in the
   * adapter. Return undefined to signal "this body doesn't identify a
   * session" (the adapter responds 400). Omit entirely to use the
   * adapter's default — a client-supplied `sessionId` field, the same
   * shape adapters/cli.ts's --session flag already uses. */
  sessionIdFor?: (body: Record<string, unknown>) => string | undefined
}
