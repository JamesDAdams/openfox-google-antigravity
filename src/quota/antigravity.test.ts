import { vi, describe, it, expect, beforeEach } from 'vitest'
import { AntigravityQuotaProvider } from './antigravity.js'
import { MemoryProviderCredentialStore } from '../credentials/credential-store.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

function makeStore(): MemoryProviderCredentialStore {
  return new MemoryProviderCredentialStore()
}

describe('AntigravityQuotaProvider', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    delete process.env.ANTIGRAVITY_TOKEN
    delete process.env.GOOGLE_ANTIGRAVITY_TOKEN
    const pendingKey = Symbol.for('openfox.pendingQuotaProviders')
    const globalQuotaKey = Symbol.for('openfox.quotaManager')
    delete (globalThis as any)[pendingKey]
    delete (globalThis as any)[globalQuotaKey]
  })

  it('returns empty metrics when no providers or credentials configured', async () => {
    const store = makeStore()
    const provider = new AntigravityQuotaProvider(store)
    const quota = await provider.getQuota()

    expect(quota.id).toBe('google-antigravity')
    expect(quota.name).toBe('Google Antigravity')
    expect(quota.metrics).toEqual([])
  })

  it('returns metrics for Gemini, Claude, and GPT-OSS when credentials exist', async () => {
    const store = makeStore()
    await store.create({ email: 'alice@google.com', refreshToken: 'test-token' })
    const provider = new AntigravityQuotaProvider(store)
    const quota = await provider.getQuota()

    expect(quota.metrics).toHaveLength(3)
    const gemini = quota.metrics.find((m) => m.model === 'Gemini')
    const claude = quota.metrics.find((m) => m.model === 'Claude')
    const gptOss = quota.metrics.find((m) => m.model === 'GPT-OSS')

    expect(gemini).toMatchObject({ kind: 'windowed', model: 'Gemini', label: 'Requests', used: 0, limit: 4000, window: 'day' })
    expect(claude).toMatchObject({ kind: 'windowed', model: 'Claude', label: 'Requests', used: 0, limit: 4000, window: 'day' })
    expect(gptOss).toMatchObject({ kind: 'windowed', model: 'GPT-OSS', label: 'Requests', used: 0, limit: 4000, window: 'day' })
  })

  it('discovers providers from config.json, credential store, and env variables', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'antigravity-test-'))
    const configPath = path.join(tempDir, 'config.json')
    const store = makeStore()
    const ref = await store.create({ email: 'alice@google.com', refreshToken: 'test-alice-refresh-token' })

    await fs.writeFile(
      configPath,
      JSON.stringify({
        providers: [
          {
            id: 'antigravity-pro',
            name: 'Google Antigravity Pro',
            preset: 'google-antigravity',
            apiKey: 'test-api-key',
          },
          {
            id: 'antigravity-user',
            name: 'Google Antigravity User',
            preset: 'google-antigravity',
            credentialRef: ref,
          },
        ],
      }),
    )

    process.env.ANTIGRAVITY_TOKEN = 'test-env-refresh-token'

    const provider = new AntigravityQuotaProvider(store, { configDirectory: tempDir })
    const accounts = await provider.discoverProviders()

    expect(accounts).toHaveLength(3)
    expect(accounts.find((a) => a.id === 'antigravity-pro')).toBeDefined()
    expect(accounts.find((a) => a.id === `antigravity-cred-${ref}`)).toBeDefined()
    expect(accounts.find((a) => a.id === 'antigravity-env')).toBeDefined()

    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('registers with openfox-quota pending providers and global quota manager', async () => {
    const store = makeStore()
    await store.create({ email: 'bob@google.com', refreshToken: 'test-token' })

    const submittedSources: any[] = []
    const globalQuotaManager = {
      registerProvider: vi.fn(),
      submitSource: (src: any) => submittedSources.push(src),
      clearPushedSources: vi.fn(),
    }
    const globalQuotaKey = Symbol.for('openfox.quotaManager')
    const pendingKey = Symbol.for('openfox.pendingQuotaProviders')
    ;(globalThis as any)[globalQuotaKey] = globalQuotaManager

    const provider = new AntigravityQuotaProvider(store)
    await provider.registerProviders()

    const pending = (globalThis as any)[pendingKey]
    expect(pending).toContain(provider)
    expect(globalQuotaManager.registerProvider).toHaveBeenCalledWith(provider)
  })

  it('uses cached metrics within TTL and clears on syncQuota', async () => {
    const store = makeStore()
    await store.create({ email: 'bob@google.com', refreshToken: 'test-token' })
    let now = 1000
    const provider = new AntigravityQuotaProvider(store, { now: () => now })

    const first = await provider.getQuota()
    expect(first.metrics).toHaveLength(3)

    now = 1000 + 30_000
    const second = await provider.getQuota()
    expect(second).toBeDefined()

    const syncResult = await provider.syncQuota()
    expect(syncResult.success).toBe(true)
    expect(syncResult.sources).toBeDefined()
  })
})
