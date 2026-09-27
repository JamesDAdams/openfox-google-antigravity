import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const ANTIGRAVITY_PRESET = 'google-antigravity'
const ANTIGRAVITY_TRANSPORT = 'google-antigravity-transport'
const ANTIGRAVITY_AUTH = 'google-antigravity-auth'

/**
 * Provider ids of the OpenFox providers wired to this plugin. Accounts are
 * owned by the provider that created them, so the plugin needs the list to
 * re-link credentials whose stored owner is unknown.
 */
export async function readAntigravityProviderIds(configDirectory: string): Promise<string[]> {
  try {
    const raw = await readFile(join(configDirectory, 'config.json'), 'utf8')
    const data = JSON.parse(raw) as { providers?: unknown }
    if (!Array.isArray(data.providers)) return []
    const ids: string[] = []
    for (const provider of data.providers) {
      if (!provider || typeof provider !== 'object') continue
      const candidate = provider as Record<string, unknown>
      const isAntigravity =
        candidate['preset'] === ANTIGRAVITY_PRESET ||
        candidate['transportAdapter'] === ANTIGRAVITY_TRANSPORT ||
        candidate['authAdapter'] === ANTIGRAVITY_AUTH
      const id = candidate['id']
      if (isAntigravity && typeof id === 'string' && id) ids.push(id)
    }
    return ids
  } catch {
    return []
  }
}
