import type { AgentConfig } from 'loopengine'

export const config: AgentConfig = {
  name: 'weather-agent',
  systemPrompt: 'You are ...',
  model: { provider: 'anthropic', model: 'claude-sonnet-5' }, // reads ANTHROPIC_API_KEY
}
