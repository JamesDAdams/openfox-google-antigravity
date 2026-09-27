import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderCredentialStore } from '../credentials/credential-store.js'
import type { AntigravityCredential } from '../auth/antigravity-auth.js'
import { refreshAccessToken, fetchProjectId } from '../auth/google-oauth.js'
import {
  ANTIGRAVITY_LOAD_ENDPOINTS,
  ANTIGRAVITY_DEFAULT_PROJECT_ID,
  getAntigravityHeaders,
} from '../constants.js'
import type {
  QuotaProvider,
  QuotaSource,
  QuotaMetric,
  PluginRegistry,
} from './contract.js'

const CACHE_TTL_MS = 60_000

const GLOBAL_QUOTA_KEY = Symbol.for('openfox.quotaManager')
const PENDING_PROVIDERS_KEY = Symbol.for('openfox.pendingQuotaProviders')

interface AntigravityModelEntry {
  displayName?: string
  maxTokens?: number
  maxOutputTokens?: number
  supportsImages?: boolean
  supportedMimeTypes?: Record<string, boolean>
  quotaInfo?: { remainingFraction?: number; resetTime?: string }
}

export interface AntigravityProviderAccount {
  id: string
  name: string
  refreshToken?: string
  accessToken?: string
  email?: string
  projectId?: string
  sourceId: string
  isDefault?: boolean
}

export interface AntigravityQuotaProviderOptions {
  fetcher?: typeof fetch
  now?: () => number
  configDirectory?: string
  getSettings?: () => { mergeSubscriptions?: boolean }
}

interface CacheEntry {
  metrics: QuotaMetric[]
  name: string
  cachedAt: number
}

export function mergeQuotaSources(sources: QuotaSource[]): QuotaSource {
  if (sources.length === 0) {
    return { id: 'google-antigravity', name: 'Google Antigravity', metrics: [] }
  }
  if (sources.length === 1) {
    return sources[0]!
  }

  const mergedMetricsMap = new Map<string, { metric: QuotaMetric; count: number }>()

  for (const src of sources) {
    for (const m of src.metrics) {
      const key = `${m.kind}:${m.label}:${m.model ?? ''}:${m.kind === 'windowed' ? m.window : ''}`
      const existing = mergedMetricsMap.get(key)
      if (!existing) {
        mergedMetricsMap.set(key, {
          metric: { ...m },
          count: 1,
        })
      } else {
        if (m.kind === 'windowed' && existing.metric.kind === 'windowed') {
          existing.metric.used += m.used
          existing.metric.limit += m.limit
          if (m.resetsAt) {
            existing.metric.resetsAt = m.resetsAt
          }
        } else if (m.kind === 'token-balance' && existing.metric.kind === 'token-balance') {
          existing.metric.total += m.total
          existing.metric.remaining += m.remaining
        }
        existing.count += 1
      }
    }
  }

  return {
    id: 'google-antigravity',
    name: `Google Antigravity (${sources.length} accounts)`,
    description: `Combined usage across ${sources.length} subscriptions`,
    metrics: Array.from(mergedMetricsMap.values()).map((v) => v.metric),
  }
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
  private readonly getSettings?: () => { mergeSubscriptions?: boolean }
  private readonly fetcher: typeof fetch
  private readonly cache = new Map<string, CacheEntry>()

  constructor(
    private readonly credentials: ProviderCredentialStore,
    options: AntigravityQuotaProviderOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.configDirectory = options.configDirectory
    this.getSettings = options.getSettings
    this.fetcher = options.fetcher ?? fetch
  }

  private isMergeSubscriptionsEnabled(): boolean {
    const settings = this.getSettings?.()
    return settings?.mergeSubscriptions !== false
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
                projectId: cred.projectId,
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

  private async fetchModelsForAccount(
    account: AntigravityProviderAccount,
  ): Promise<Record<string, AntigravityModelEntry> | null> {
    let accessToken = account.accessToken
    let refreshToken = account.refreshToken
    let projectId = account.projectId
    let accessExpiresAt: number | undefined

    if (account.sourceId.startsWith('antigravity-cred-')) {
      const ref = account.sourceId.replace('antigravity-cred-', '')
      try {
        const cred = (await this.credentials.get(ref)) as AntigravityCredential | undefined
        if (cred) {
          accessToken = cred.accessToken || accessToken
          refreshToken = cred.refreshToken || refreshToken
          projectId = cred.projectId || projectId
          accessExpiresAt = cred.accessExpiresAt
        }
      } catch {
        // Ignore
      }
    }

    const now = this.now()
    if (!accessToken || !accessExpiresAt || now >= accessExpiresAt - 60000) {
      if (refreshToken) {
        try {
          const refreshed = await refreshAccessToken(refreshToken)
          accessToken = refreshed.access_token
          if (account.sourceId.startsWith('antigravity-cred-')) {
            const ref = account.sourceId.replace('antigravity-cred-', '')
            const cred = (await this.credentials.get(ref)) as AntigravityCredential | undefined
            if (cred) {
              cred.accessToken = refreshed.access_token
              cred.accessExpiresAt = now + refreshed.expires_in * 1000
              await this.credentials.set(ref, cred)
            }
          }
        } catch {
          // Ignore
        }
      }
    }

    if (!accessToken) return null

    if (!projectId || projectId === ANTIGRAVITY_DEFAULT_PROJECT_ID) {
      try {
        const discoveredProj = await fetchProjectId(accessToken)
        if (discoveredProj) {
          projectId = discoveredProj
        }
      } catch {
        // Ignore
      }
    }

    const antigravityHeaders = getAntigravityHeaders()
    const targetProject = projectId || ANTIGRAVITY_DEFAULT_PROJECT_ID

    for (const endpoint of ANTIGRAVITY_LOAD_ENDPOINTS) {
      try {
        const res = await this.fetcher(`${endpoint}/v1internal:fetchAvailableModels`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            'User-Agent': antigravityHeaders['User-Agent'],
            'Client-Metadata': antigravityHeaders['Client-Metadata'],
          },
          body: JSON.stringify({ project: targetProject }),
          signal: AbortSignal.timeout(10000),
        })

        if (!res.ok) {
          if (res.status === 401 && refreshToken) {
            try {
              const refreshed = await refreshAccessToken(refreshToken)
              accessToken = refreshed.access_token
              const retryRes = await this.fetcher(`${endpoint}/v1internal:fetchAvailableModels`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${accessToken}`,
                  'User-Agent': antigravityHeaders['User-Agent'],
                  'Client-Metadata': antigravityHeaders['Client-Metadata'],
                },
                body: JSON.stringify({ project: targetProject }),
                signal: AbortSignal.timeout(10000),
              })
              if (retryRes.ok) {
                const retryData = (await retryRes.json()) as { models?: Record<string, AntigravityModelEntry> }
                if (retryData.models && Object.keys(retryData.models).length > 0) {
                  return retryData.models
                }
              }
            } catch {
              // Ignore retry error
            }
          }
          continue
        }

        const data = (await res.json()) as { models?: Record<string, AntigravityModelEntry> }
        if (data.models && Object.keys(data.models).length > 0) {
          return data.models
        }
      } catch {
        // Try next endpoint
      }
    }

    return null
  }

  private modelEntriesToMetrics(models: Record<string, AntigravityModelEntry>): QuotaMetric[] {
    const familyStats: Record<
      'gemini' | 'claude' | 'gpt-oss',
      { maxUsedFraction: number; resetsAt?: string; hasData: boolean }
    > = {
      gemini: { maxUsedFraction: 0, hasData: false },
      claude: { maxUsedFraction: 0, hasData: false },
      'gpt-oss': { maxUsedFraction: 0, hasData: false },
    }

    for (const [key, entry] of Object.entries(models)) {
      if (!entry.quotaInfo) continue
      const lower = (key + ' ' + (entry.displayName || '')).toLowerCase()

      let family: 'gemini' | 'claude' | 'gpt-oss' | null = null
      if (lower.includes('claude')) {
        family = 'claude'
      } else if (lower.includes('gpt-oss') || lower.includes('gpt_oss')) {
        family = 'gpt-oss'
      } else if (lower.includes('gemini') || lower.includes('chat_') || lower.includes('tab_flash')) {
        family = 'gemini'
      }

      if (family) {
        let remainingFraction = 1
        if (typeof entry.quotaInfo.remainingFraction === 'number') {
          remainingFraction = Math.max(0, Math.min(1, entry.quotaInfo.remainingFraction))
        } else if (entry.quotaInfo.resetTime) {
          // When Google Antigravity quota is fully exhausted (0% left), remainingFraction is omitted by the API
          remainingFraction = 0
        }
        const usedFraction = 1 - remainingFraction
        familyStats[family].hasData = true
        if (usedFraction > familyStats[family].maxUsedFraction) {
          familyStats[family].maxUsedFraction = usedFraction
        }
        if (entry.quotaInfo.resetTime) {
          familyStats[family].resetsAt = entry.quotaInfo.resetTime
        }
      }
    }

    const defaultReset = getNextResetTime()
    const FAMILY_LIMIT = 1000

    return [
      {
        kind: 'windowed',
        model: 'Gemini',
        label: 'Requests',
        used: Math.round(familyStats.gemini.maxUsedFraction * FAMILY_LIMIT),
        limit: FAMILY_LIMIT,
        window: 'day',
        resetsAt: familyStats.gemini.resetsAt || defaultReset,
      },
      {
        kind: 'windowed',
        model: 'Claude',
        label: 'Requests',
        used: Math.round(familyStats.claude.maxUsedFraction * FAMILY_LIMIT),
        limit: FAMILY_LIMIT,
        window: 'day',
        resetsAt: familyStats.claude.resetsAt || defaultReset,
      },
      {
        kind: 'windowed',
        model: 'GPT-OSS',
        label: 'Requests',
        used: Math.round(familyStats['gpt-oss'].maxUsedFraction * FAMILY_LIMIT),
        limit: FAMILY_LIMIT,
        window: 'day',
        resetsAt: familyStats['gpt-oss'].resetsAt || defaultReset,
      },
    ]
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

      const models = await this.fetchModelsForAccount(account)
      const metrics = models ? this.modelEntriesToMetrics(models) : []
      const finalMetrics = metrics.length > 0 ? metrics : this.getDefaultMetrics()

      this.cache.set(account.id, {
        metrics: finalMetrics,
        name: source.name,
        cachedAt: this.now(),
      })

      return { ...source, metrics: finalMetrics }
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

    if (this.isMergeSubscriptionsEnabled()) {
      const merged = mergeQuotaSources(sources)
      this.submitSourcesToGlobalManager(accounts, [merged])
      return merged
    }

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

    if (this.isMergeSubscriptionsEnabled() && sources.length > 0) {
      const merged = mergeQuotaSources(sources)
      this.submitSourcesToGlobalManager(accounts, [merged])
    } else {
      this.submitSourcesToGlobalManager(accounts, sources)
    }

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

    if (this.isMergeSubscriptionsEnabled()) {
      return
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
        limit: 1000,
        window: 'day',
        resetsAt,
      },
      {
        kind: 'windowed',
        model: 'Claude',
        label: 'Requests',
        used: 0,
        limit: 1000,
        window: 'day',
        resetsAt,
      },
      {
        kind: 'windowed',
        model: 'GPT-OSS',
        label: 'Requests',
        used: 0,
        limit: 1000,
        window: 'day',
        resetsAt,
      },
    ]
  }
}
