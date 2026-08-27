import type { AgentConfig } from 'loopengine'

export const config: AgentConfig = {
  name: 'weather-agent',
  systemPrompt: 'You are ...',
  model: { provider: 'deepseek', model: 'deepseek-v4-flash' }, // reads DEEPSEEK_API_KEY
}
