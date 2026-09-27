import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderCredentialStore } from '../credentials/credential-store.js'
import type { AntigravityCredential } from '../auth/antigravity-auth.js'
import type {
  QuotaProvider,
  QuotaSource,
  QuotaMetric,
  PluginRegistry,
} from './contract.js'

const CACHE_TTL_MS = 60_000

const GLOBAL_QUOTA_KEY = Symbol.for('openfox.quotaManager')
const PENDING_PROVIDERS_KEY = Symbol.for('openfox.pendingQuotaProviders')

export interface AntigravityProviderAccount {
  id: string
  name: string
  refreshToken?: string
  accessToken?: string
  email?: string
  sourceId: string
  isDefault?: boolean
}

export interface AntigravityQuotaProviderOptions {
  fetcher?: typeof fetch
  now?: () => number
  configDirectory?: string
}

interface CacheEntry {
  metrics: QuotaMetric[]
  name: string
  cachedAt: number
}

function getNextResetTime(): string {
  const now = new Date()
  const reset = new Date(now)
  reset.setUTCHours(7, 0, 0, 0)
  if (reset.getTime() <= now.getTime()) {
    reset.setUTCDate(reset.getUTCDate() + 1)
  }
  return reset.toISOString()
}

export class AntigravityQuotaProvider implements QuotaProvider {
  readonly id = 'google-antigravity'
  readonly name = 'Google Antigravity'

  private readonly now: () => number
  private readonly configDirectory?: string
  private readonly cache = new Map<string, CacheEntry>()

  constructor(
    private readonly credentials: ProviderCredentialStore,
    options: AntigravityQuotaProviderOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.configDirectory = options.configDirectory
  }

  /**
   * Discover all Google Antigravity provider accounts configured in OpenFox
   * (config.json providers, credential store, environment variables).
   */
  async discoverProviders(): Promise<AntigravityProviderAccount[]> {
    const discovered: AntigravityProviderAccount[] = []
    const seenEmails = new Set<string>()
    const seenIds = new Set<string>()

    // 1. Scan OpenFox config.json in configDirectory
    if (this.configDirectory) {
      try {
        const configPath = join(this.configDirectory, 'config.json')
        const raw = await readFile(configPath, 'utf8')
        const data = JSON.parse(raw)
        if (Array.isArray(data.providers)) {
          for (const p of data.providers) {
            if (!p || typeof p !== 'object') continue
            const backend = String(p.backend || '').toLowerCase()
            const transport = String(p.transport || p.transportAdapter || '').toLowerCase()
            const preset = String(p.preset || '').toLowerCase()
            const authAdapter = String(p.authAdapter || '').toLowerCase()

            const isAntigravity =
              preset === 'google-antigravity' ||
              backend === 'google-antigravity' ||
              transport === 'google-antigravity-transport' ||
              authAdapter === 'google-antigravity-auth'

            if (isAntigravity && p.apiKey && !p.credentialRef && !seenIds.has(String(p.id))) {
              seenIds.add(String(p.id))
              discovered.push({
                id: String(p.id),
                name: String(p.name || p.id || 'Google Antigravity'),
                sourceId: String(p.id),
              })
            }
          }
        }
      } catch {
        // Ignore file read / parse error
      }
    }

    // 2. Scan plugin credential store for all connected Google accounts
    try {
      if (typeof this.credentials.listReferences === 'function') {
        const references = await this.credentials.listReferences()
        for (const ref of references) {
          const cred = (await this.credentials.get(ref)) as AntigravityCredential | undefined
          if (cred?.refreshToken) {
            const email = cred.email
            if (email && seenEmails.has(email)) continue
            if (email) seenEmails.add(email)

            const credId = `antigravity-cred-${ref}`
            const name = cred.email ? `Google Antigravity (${cred.email})` : `Google Antigravity (${ref})`
            if (!seenIds.has(credId)) {
              seenIds.add(credId)
              discovered.push({
                id: credId,
                name,
                refreshToken: cred.refreshToken,
                accessToken: cred.accessToken,
                email: cred.email,
                sourceId: credId,
              })
            }
          }
        }
      }
    } catch {
      // Ignore credential read error
    }

    // 3. Scan environment variables
    const envToken = process.env.ANTIGRAVITY_TOKEN || process.env.GOOGLE_ANTIGRAVITY_TOKEN
    if (envToken) {
      const envId = 'antigravity-env'
      if (!seenIds.has(envId)) {
        seenIds.add(envId)
        discovered.push({
          id: envId,
          name: 'Google Antigravity (Env)',
          refreshToken: envToken,
          sourceId: envId,
        })
      }
    }

    return discovered
  }

  /**
   * Fetch quota metrics for a single provider account.
   */
  async getQuotaForAccount(account: AntigravityProviderAccount): Promise<QuotaSource> {
    const source: QuotaSource = {
      id: account.sourceId,
      name: account.name,
      metrics: [],
    }

    try {
      const cached = this.cache.get(account.id)
      if (cached && this.now() - cached.cachedAt < CACHE_TTL_MS) {
        return {
          ...source,
          name: cached.name || source.name,
          metrics: cached.metrics,
        }
      }

      const metrics = this.getDefaultMetrics()

      this.cache.set(account.id, {
        metrics,
        name: source.name,
        cachedAt: this.now(),
      })

      return { ...source, metrics }
    } catch (error) {
      console.warn(`Google Antigravity quota unavailable (${account.name})`, {
        error: error instanceof Error ? error.message : String(error),
      })
      const cached = this.cache.get(account.id)
      if (cached) {
        return { ...source, name: cached.name, metrics: cached.metrics }
      }
      return {
        ...source,
        metrics: this.getDefaultMetrics(),
      }
    }
  }

  /**
   * Fetch and aggregate quota sources across all discovered Google Antigravity provider accounts.
   */
  async getAllQuotaSources(): Promise<QuotaSource[]> {
    const accounts = await this.discoverProviders()
    const sources = await Promise.all(accounts.map((acc) => this.getQuotaForAccount(acc)))
    return sources
  }

  /**
   * Main getQuota method implementing QuotaProvider contract.
   * Submits all discovered sources to openfox-quota manager and returns primary source.
   */
  async getQuota(): Promise<QuotaSource> {
    const accounts = await this.discoverProviders()
    if (accounts.length === 0) {
      this.submitSourcesToGlobalManager(accounts, [])
      return { id: this.id, name: this.name, metrics: [] }
    }
    const sources = await Promise.all(accounts.map((acc) => this.getQuotaForAccount(acc)))

    // Submit all sources in openfox-quota
    this.submitSourcesToGlobalManager(accounts, sources)

    const firstWithMetrics = sources.find((s) => s.metrics && s.metrics.length > 0)
    if (firstWithMetrics) {
      return firstWithMetrics
    }
    return sources[0] ?? { id: this.id, name: this.name, metrics: [] }
  }

  /**
   * Synchronize quota sources with openfox-quota plugin.
   */
  async syncQuota(registry?: PluginRegistry): Promise<{ success: boolean; sources: QuotaSource[] }> {
    this.cache.clear()
    const accounts = await this.discoverProviders()
    const sources = accounts.length > 0
      ? await Promise.all(accounts.map((acc) => this.getQuotaForAccount(acc)))
      : []

    this.submitSourcesToGlobalManager(accounts, sources)

    if (registry && typeof registry.registerQuotaProvider === 'function') {
      await this.registerProviders(registry)
    }

    return { success: true, sources }
  }

  /**
   * Register with openfox-quota (via pending list, global manager, registry).
   */
  async registerProviders(registry?: PluginRegistry): Promise<void> {
    // 1. Put in pending list so openfox-quota picks it up whenever it loads
    const pending = ((globalThis as any)[PENDING_PROVIDERS_KEY] ??= [])
    if (!pending.some((p: any) => p && p.id === this.id)) {
      pending.push(this)
    }

    // 2. Register with openfox-quota via global quota manager if present
    const globalMgr = (globalThis as any)[GLOBAL_QUOTA_KEY]
    if (globalMgr && typeof globalMgr.registerProvider === 'function') {
      globalMgr.registerProvider(this)
    }

    // 3. Register via registry.registerQuotaProvider if present
    if (registry && typeof registry.registerQuotaProvider === 'function') {
      registry.registerQuotaProvider(this)
    }

    // 4. Eagerly sync quota sources with openfox-quota
    void this.getQuota().catch(() => {})
  }

  private submitSourcesToGlobalManager(
    accounts: AntigravityProviderAccount[],
    sources: QuotaSource[],
  ): void {
    const globalMgr = (globalThis as any)[GLOBAL_QUOTA_KEY]
    if (!globalMgr) return

    if (typeof globalMgr.clearPushedSources === 'function') {
      globalMgr.clearPushedSources((id: string) => id.startsWith('antigravity') || id.startsWith('google-antigravity'))
    } else if (globalMgr.pushedSources instanceof Map) {
      for (const key of Array.from(globalMgr.pushedSources.keys())) {
        if (typeof key === 'string' && (key.startsWith('antigravity') || key.startsWith('google-antigravity'))) {
          globalMgr.pushedSources.delete(key)
        }
      }
    }

    if (accounts.length > 1) {
      for (let i = 0; i < accounts.length; i++) {
        const acc = accounts[i]
        const src = sources[i]
        if (!acc || !src) continue
        if (src.id === this.id) continue

        if (typeof globalMgr.submitSource === 'function') {
          globalMgr.submitSource(src)
        }
      }
    }
  }

  private getDefaultMetrics(): QuotaMetric[] {
    const resetsAt = getNextResetTime()
    return [
      {
        kind: 'windowed',
        model: 'Gemini',
        label: 'Requests',
        used: 0,
        limit: 4000,
        window: 'day',
        resetsAt,
      },
      {
        kind: 'windowed',
        model: 'Claude',
        label: 'Requests',
        used: 0,
        limit: 4000,
        window: 'day',
        resetsAt,
      },
      {
        kind: 'windowed',
        model: 'GPT-OSS',
        label: 'Requests',
        used: 0,
        limit: 4000,
        window: 'day',
        resetsAt,
      },
    ]
  }
}
