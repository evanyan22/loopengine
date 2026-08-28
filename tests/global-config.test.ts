import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { describeModelProviders, describeGateways } from '../web/global-config.js'

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-composio-cli.mjs')

describe('describeModelProviders', () => {
  const originalKeys = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(originalKeys)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('reports every known provider with its env var and configured status', () => {
    delete process.env.ANTHROPIC_API_KEY
    process.env.OPENAI_API_KEY = 'sk-test'
    delete process.env.DEEPSEEK_API_KEY

    const { providers } = describeModelProviders()
    expect(providers).toEqual([
      { provider: 'anthropic', envVar: 'ANTHROPIC_API_KEY', configured: false },
      { provider: 'openai', envVar: 'OPENAI_API_KEY', configured: true },
      { provider: 'deepseek', envVar: 'DEEPSEEK_API_KEY', configured: false },
    ])
  })

  it('lists every registered agent with a resolved model config, from the real agents/ registry', () => {
    const { agents } = describeModelProviders()
    // core/agent-registry.ts discovers the repo's own real agents/ directory
    // at import time (see its own top-level await) — customer-service is
    // one of this repo's real demo agents, with a known, hand-set model.
    expect(agents).toContainEqual({ agent: 'customer-service', provider: 'deepseek', model: 'deepseek-v4-pro' })
  })
})

describe('describeGateways', () => {
  it('reports composio as connected when the CLI whoami succeeds', async () => {
    const { gateways } = await describeGateways(FAKE_CLI)
    const composio = gateways.find((g) => g.provider === 'composio')
    expect(composio).toEqual({ provider: 'composio', supported: true, connected: true, email: 'test@example.com', org: 'test-org' })
  })

  it('reports composio as not connected when the CLI whoami fails', async () => {
    const original = process.env.COMPOSIO_FAKE_WHOAMI_FAIL
    process.env.COMPOSIO_FAKE_WHOAMI_FAIL = '1'
    try {
      const { gateways } = await describeGateways(FAKE_CLI)
      const composio = gateways.find((g) => g.provider === 'composio')
      expect(composio).toEqual({ provider: 'composio', supported: true, connected: false, email: undefined, org: undefined })
    } finally {
      if (original === undefined) delete process.env.COMPOSIO_FAKE_WHOAMI_FAIL
      else process.env.COMPOSIO_FAKE_WHOAMI_FAIL = original
    }
  })

  it('lists the not-yet-supported gateway placeholders', async () => {
    const { gateways } = await describeGateways(FAKE_CLI)
    const names = gateways.map((g) => g.provider)
    expect(names).toEqual(['composio', 'scalekit', 'nango', 'arcade'])
    for (const provider of ['scalekit', 'nango', 'arcade']) {
      expect(gateways.find((g) => g.provider === provider)).toEqual({ provider, supported: false, connected: false })
    }
  })
})
