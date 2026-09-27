import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readAntigravityProviderIds } from './providers.js'

async function configDir(providers: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'openfox-antigravity-config-'))
  await writeFile(join(dir, 'config.json'), JSON.stringify({ providers }), 'utf8')
  return dir
}

describe('readAntigravityProviderIds', () => {
  it('collects providers wired to the plugin by preset, transport or auth adapter', async () => {
    const dir = await configDir([
      { id: 'by-preset', preset: 'google-antigravity' },
      { id: 'by-transport', transportAdapter: 'google-antigravity-transport' },
      { id: 'by-auth', authAdapter: 'google-antigravity-auth' },
      { id: 'unrelated', preset: 'openai', transportAdapter: 'other-transport' },
    ])

    expect(await readAntigravityProviderIds(dir)).toEqual(['by-preset', 'by-transport', 'by-auth'])
  })

  it('returns nothing when the config is missing or malformed', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'openfox-antigravity-config-'))
    expect(await readAntigravityProviderIds(empty)).toEqual([])

    const dir = await configDir([])
    await writeFile(join(dir, 'config.json'), 'not json', 'utf8')
    expect(await readAntigravityProviderIds(dir)).toEqual([])
  })
})
