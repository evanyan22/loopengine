// Formerly the standalone `mcpplug` package — folded in here since it
// had exactly one real consumer (gateway-tools.ts, below) and the
// "usable by any agent runtime" framing it shipped with was aspirational,
// never actually exercised by a second host. Reuses this repo's own
// ToolDefinition (agent-config.ts) directly instead of mcpplug's own
// parallel-but-identical copy — that duplication only existed to keep
// mcpplug import-free of loopengine, which stopped mattering once it
// moved in.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ToolDefinition } from './agent-config.js'

const run = promisify(execFile)

/** One connection to one external tool gateway (Composio today; a raw MCP
 * client is a later, separate source). `name` is used to namespace every
 * tool it produces, so two sources never collide. */
export interface ToolSource {
  name: string
  loadTools(): Promise<ToolDefinition[]>
  close(): Promise<void>
}

export interface ComposioSourceOptions {
  /** Composio tool slugs to expose, e.g.
   * "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER". Explicit, not
   * auto-discovered — same reasoning actauth rules are opt-in per tool
   * rather than a blanket allow; an agent should only see the Composio
   * actions its config actually lists. */
  slugs: string[]
  /** Defaults to 'composio' — override to point at a stand-in binary in tests. */
  cliCommand?: string
}

function humanize(slug: string): string {
  return slug.toLowerCase().split('_').join(' ')
}

async function runCli(cliCommand: string, args: string[]): Promise<Record<string, unknown>> {
  let stdout: string
  try {
    ;({ stdout } = await run(cliCommand, args))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`composio CLI call failed (${args.join(' ')}): ${message}`)
  }
  try {
    return JSON.parse(stdout) as Record<string, unknown>
  } catch {
    throw new Error(`composio CLI returned non-JSON output for ${args.join(' ')}: ${stdout}`)
  }
}

/** Sources ToolDefinitions from the Composio CLI — already-authenticated
 * (`composio link <toolkit>`) tool execution across 1000+ apps, so this
 * source needs no OAuth code of its own; Composio owns that entirely. */
export async function connectComposioSource(name: string, options: ComposioSourceOptions): Promise<ToolSource> {
  const cliCommand = options.cliCommand ?? 'composio'

  return {
    name,
    async loadTools(): Promise<ToolDefinition[]> {
      const tools: ToolDefinition[] = []
      for (const slug of options.slugs) {
        const schema = await runCli(cliCommand, ['execute', slug, '--get-schema'])
        const inputSchema = (schema.inputSchema as Record<string, unknown>) ?? {}
        tools.push({
          name: `${name}_${slug}`,
          description: humanize(slug),
          input_schema: inputSchema,
          execute: async (input) => {
            const result = await runCli(cliCommand, ['execute', slug, '-d', JSON.stringify(input)])
            if (result.successful === false || result.error) {
              throw new Error(`composio tool ${slug} failed: ${JSON.stringify(result.error ?? result)}`)
            }
            return result.data ?? result
          },
        })
      }
      return tools
    },
    // Each call is its own subprocess — nothing held open between calls,
    // so there's nothing to tear down. Kept for symmetry with sources
    // that do hold a live connection (e.g. a future raw MCP client).
    close: async () => {},
  }
}
