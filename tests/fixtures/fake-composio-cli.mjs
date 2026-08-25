#!/usr/bin/env node
// A stand-in for the real `composio` binary, same shape mcpplug's own
// test fixture uses — see its tests/fixtures/fake-composio-cli.mjs.
// Copied rather than shared across repos since mcpplug is a published
// dependency here, not a workspace sibling this repo can reach into.
// COMPOSIO_FAKE_LOG, if set, gets one line appended per invocation — how
// gateway-tools.test.ts's caching test verifies whether a given call
// actually shelled out again or hit loadGatewayToolsFromDir's cache.
import { appendFileSync } from 'node:fs'

const [, , cmd, ...rest] = process.argv
if (process.env.COMPOSIO_FAKE_LOG) appendFileSync(process.env.COMPOSIO_FAKE_LOG, `${cmd} ${rest.join(' ')}\n`)

if (cmd === 'connections' && rest[0] === 'list') {
  process.stdout.write(
    JSON.stringify({
      github: [{ status: 'ACTIVE', alias: null, word_id: 'github_test' }],
      slack: [{ status: 'EXPIRED', alias: null, word_id: 'slack_test' }],
    }),
  )
  process.exit(0)
}

if (cmd === 'tools' && rest[0] === 'list') {
  const toolkit = rest[1]
  if (toolkit === 'github') {
    process.stdout.write(
      JSON.stringify([
        { slug: 'GITHUB_LIST_REPOS', name: 'List repos', description: 'List the authenticated user’s repositories.', tags: [] },
        { slug: 'GITHUB_CREATE_ISSUE', name: 'Create issue', description: 'Create an issue in a repository.', tags: [] },
      ]),
    )
    process.exit(0)
  }
  process.stdout.write(JSON.stringify([]))
  process.exit(0)
}

if (cmd === 'whoami') {
  if (process.env.COMPOSIO_FAKE_WHOAMI_FAIL) {
    process.stderr.write('composio: not logged in\n')
    process.exit(1)
  }
  process.stdout.write(JSON.stringify({ account_type: 'human', email: 'test@example.com', current_org_name: 'test-org' }))
  process.exit(0)
}

if (cmd !== 'execute') {
  process.stderr.write(`unsupported command: ${cmd}\n`)
  process.exit(1)
}

const [slug, ...execRest] = rest

if (slug === 'BROKEN_SLUG') {
  process.stderr.write('composio: not authenticated\n')
  process.exit(1)
}

if (execRest.includes('--get-schema')) {
  process.stdout.write(
    JSON.stringify({
      slug,
      version: '1',
      schemaPath: `/fake/${slug}.json`,
      inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
    }),
  )
  process.exit(0)
}

const dIndex = execRest.indexOf('-d')
const input = dIndex >= 0 ? JSON.parse(execRest[dIndex + 1]) : {}

if (slug === 'FAIL_TOOL') {
  process.stdout.write(JSON.stringify({ successful: false, error: 'boom' }))
  process.exit(0)
}

process.stdout.write(JSON.stringify({ successful: true, data: { echoed: input } }))
