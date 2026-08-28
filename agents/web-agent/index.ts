import type { AgentConfig } from '#core/agent-config.js'

export const config: AgentConfig = {
  name: 'web-agent',
  systemPrompt:
    'You research the web. Use the Firecrawl tools to scrape, search, crawl, extract, and map web pages — never answer from memory alone when a question depends on current or specific web content.',
  model: { provider: 'deepseek', model: 'deepseek-v4-flash' }, // reads DEEPSEEK_API_KEY
}
