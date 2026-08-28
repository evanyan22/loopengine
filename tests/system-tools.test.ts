import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { systemTools } from '#core/system-tools/index.js'

const readFile = systemTools.find((t) => t.name === 'system_read_file')!

describe('systemTools system_read_file', () => {
  it('reads a file inside the OS temp directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-tools-test-'))
    const file = join(dir, 'inside.txt')
    writeFileSync(file, 'hello from temp')

    try {
      expect(await readFile.execute({ path: file })).toBe('hello from temp')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a file outside the OS temp directory', async () => {
    // process.cwd() (this repo checkout) is never under os.tmpdir().
    const outside = join(process.cwd(), 'package.json')

    await expect(readFile.execute({ path: outside })).rejects.toThrow(/can only read files under the OS temp directory/)
  })

  it('rejects a symlink inside the temp dir that escapes to a file outside it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-tools-test-'))
    const link = join(dir, 'escape.txt')
    const outsideTarget = join(process.cwd(), 'package.json')
    symlinkSync(outsideTarget, link)

    try {
      await expect(readFile.execute({ path: link })).rejects.toThrow(/can only read files under the OS temp directory/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a nonexistent path with a clear error rather than a raw ENOENT', async () => {
    const missing = join(tmpdir(), 'system-tools-test-does-not-exist', 'nope.txt')

    await expect(readFile.execute({ path: missing })).rejects.toThrow(/No such file/)
  })

  it('reads a real subdirectory under the temp dir (e.g. a composio output dir)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-tools-test-'))
    const nested = join(dir, 'composio', 'adhoc_123')
    mkdirSync(nested, { recursive: true })
    const file = join(nested, 'OUTPUT.json')
    writeFileSync(file, '{"ok":true}')

    try {
      expect(await readFile.execute({ path: file })).toBe('{"ok":true}')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
