import type { ProviderAccessContext, ProviderAuthAdapter, ProviderAuthStatus, ProviderLoginChallenge } from 'openfox/provider'
import type { ProviderCredentialStore } from '../credentials/credential-store.js'
import { generatePKCE, buildAuthUrl, startOAuthServer, exchangeCode, refreshAccessToken, fetchUserEmail, fetchProjectId } from './google-oauth.js'
import { ANTIGRAVITY_VERSION } from '../constants.js'

export interface AntigravityCredential {
  providerId?: string
  refreshToken: string
  accessToken?: string
  accessExpiresAt?: number
  email?: string
  projectId?: string
  priority?: number
  cost?: number
  disabled?: boolean
  lastUsedAt?: number
  failureCount?: number
  cooldownUntil?: number
}

export interface AntigravityAccountInfo {
  providerId?: string
  credentialRef: string
  email?: string
  projectId?: string
  priority?: number
  cost?: number
  disabled?: boolean
  lastUsedAt?: number
  status: 'connected' | 'expired' | 'error'
}

export class AntigravityAuthAdapter implements ProviderAuthAdapter {
  readonly id = 'google-antigravity-auth'
  public onAccountChange?: (providerId?: string) => void
  private readonly activeLogins = new Map<string, {
    challenge: ProviderLoginChallenge
    completion: Promise<{ credentialRef: string }>
  }>()

  constructor(private readonly credentials: ProviderCredentialStore) {}

  async beginLogin(context: { providerId: string }): Promise<{
    challenge: ProviderLoginChallenge
    completion: Promise<{ credentialRef: string }>
  }> {
    const existing = this.activeLogins.get(context.providerId)
    if (existing) return existing

    const pkce = generatePKCE()
    const port = 51121
    const authUrl = buildAuthUrl(pkce.challenge, pkce.verifier, port)
    const server = startOAuthServer(port)

    const challenge: ProviderLoginChallenge = {
      mode: 'browser',
      verificationUrl: authUrl,
      directUrl: authUrl,
      instructions: `Open the link above and sign in with your Google account. The authorization will be captured automatically.`,
      expiresAt: new Date(Date.now() + 180000).toISOString(),
      intervalSeconds: 5,
    }

    const completion = server.then(async ({ code, state }) => {
      try {
        console.log('[openfox-google-antigravity] OAuth callback received, exchanging code...')
        const stateData = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as { verifier: string }
        const tokens = await exchangeCode(code, stateData.verifier, port)
        console.log('[openfox-google-antigravity] Token exchange succeeded, fetching user info...')
        const email = await fetchUserEmail(tokens.access_token)
        const projectId = await fetchProjectId(tokens.access_token)
        console.log('[openfox-google-antigravity] User info fetched, saving credential...')

        // Check if an existing credential for this email already exists for the
        // same provider — accounts are owned by the provider that created them.
        let existingRef: string | null = null
        if (typeof this.credentials.listReferences === 'function') {
          const refs = await this.credentials.listReferences()
          for (const ref of refs) {
            const existingCred = (await this.credentials.get(ref)) as AntigravityCredential | undefined
            const matchEmail = existingCred?.email && email && existingCred.email.toLowerCase() === email.toLowerCase()
            if (matchEmail && existingCred?.providerId === context.providerId) {
              existingRef = ref
              break
            }
          }
        }

        const existingAccounts = await this.listAccounts(context.providerId)
        const credential: AntigravityCredential = {
          providerId: context.providerId,
          refreshToken: tokens.refresh_token,
          accessToken: tokens.access_token,
          accessExpiresAt: Date.now() + tokens.expires_in * 1000,
          email,
          projectId,
          priority: existingAccounts.length,
        }

        let credentialRef: string
        if (existingRef) {
          await this.credentials.set(existingRef, credential)
          credentialRef = existingRef
          console.log('[openfox-google-antigravity] Existing credential updated:', credentialRef)
        } else {
          credentialRef = await this.credentials.create(credential)
          console.log('[openfox-google-antigravity] New credential created:', credentialRef)
        }

        try {
          this.onAccountChange?.(context.providerId)
        } catch {}

        // Immediately push live quota source to global quota manager upon login
        try {
          const globalQuotaKey = Symbol.for('openfox.quotaManager')
          const globalMgr = (globalThis as any)[globalQuotaKey]
          if (globalMgr) {
            const resetsAt = new Date(Date.now() + 86400000).toISOString()
            const source = {
              id: `antigravity-cred-${credentialRef}`,
              name: email ? `Google Antigravity (${email})` : `Google Antigravity`,
              metrics: [
                { kind: 'windowed' as const, model: 'Gemini', label: 'Requests', used: 0, limit: 4000, window: 'day' as const, resetsAt },
                { kind: 'windowed' as const, model: 'Claude', label: 'Requests', used: 0, limit: 4000, window: 'day' as const, resetsAt },
                { kind: 'windowed' as const, model: 'GPT-OSS', label: 'Requests', used: 0, limit: 4000, window: 'day' as const, resetsAt },
              ],
            }
            if (typeof globalMgr.submitSource === 'function') {
              globalMgr.submitSource(source)
            }
            if (typeof globalMgr.refresh === 'function') {
              globalMgr.refresh().catch(() => {})
            }
          }
        } catch {}

        return { credentialRef }
      } catch (err) {
        console.error('[openfox-google-antigravity] OAuth completion failed:', err)
        throw err
      } finally {
        this.activeLogins.delete(context.providerId)
      }
    })

    const loginObj = { challenge, completion }
    this.activeLogins.set(context.providerId, loginObj)
    return loginObj
  }

  isLoginInProgress(providerId?: string): boolean {
    if (!providerId) return false
    return this.activeLogins.has(providerId)
  }

  async getStatus(context: { providerId: string; credentialRef?: string }): Promise<ProviderAuthStatus> {
    const accounts = await this.listAccounts(context.providerId)
    if (accounts.length > 0) {
      const active = accounts.filter((a) => a.status === 'connected')
      if (active.length > 0) {
        const primary = (context.credentialRef && accounts.find((a) => a.credentialRef === context.credentialRef)) || active[0]
        const label = accounts.length > 1
          ? `${primary?.email ?? 'Google Account'} (+${accounts.length - 1})`
          : primary?.email ?? 'Google Account'
        return { state: 'connected', accountLabel: label }
      }
    }

    if (!context.credentialRef) return { state: 'disconnected' }

    const credential = (await this.credentials.get(context.credentialRef)) as AntigravityCredential | undefined
    if (!credential) return { state: 'disconnected' }

    if (credential.refreshToken) {
      return { state: 'connected', accountLabel: credential.email ?? 'Google Account' }
    }

    return { state: 'expired', accountLabel: credential.email, error: 'No refresh token available' }
  }

  /**
   * Accounts owned by `providerId`. An account always belongs to exactly one
   * provider, so without a provider id there is nothing to list — never fall
   * back to another provider's accounts.
   */
  async listAccounts(providerId?: string): Promise<AntigravityAccountInfo[]> {
    if (!providerId) return []
    if (typeof this.credentials.listReferences !== 'function') return []
    const refs = await this.credentials.listReferences()
    const result: AntigravityAccountInfo[] = []

    for (const ref of refs) {
      const cred = (await this.credentials.get(ref)) as AntigravityCredential | undefined
      if (!cred) continue
      if (cred.providerId !== providerId) continue
      result.push({
        providerId: cred.providerId,
        credentialRef: ref,
        email: cred.email,
        projectId: cred.projectId,
        priority: cred.priority,
        cost: cred.cost,
        disabled: cred.disabled,
        lastUsedAt: cred.lastUsedAt,
        status: cred.refreshToken ? 'connected' : 'expired',
      })
    }

    result.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    return result
  }

  async reorderAccount(providerId: string, credentialRef: string, direction: 'up' | 'down'): Promise<void> {
    const accounts = await this.listAccounts(providerId)
    const index = accounts.findIndex((a) => a.credentialRef === credentialRef)
    if (index === -1) return
    const targetIndex = direction === 'up' ? index - 1 : index + 1
    if (targetIndex < 0 || targetIndex >= accounts.length) return

    const [moved] = accounts.splice(index, 1)
    if (!moved) return
    accounts.splice(targetIndex, 0, moved)

    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i]!
      await this.updateAccount(acc.credentialRef, { priority: i })
    }

    try {
      this.onAccountChange?.(providerId)
    } catch {}
  }

  /** Whether `credentialRef` is an account owned by `providerId`. */
  async ownsAccount(providerId: string | undefined, credentialRef: string): Promise<boolean> {
    if (!providerId) return false
    const accounts = await this.listAccounts(providerId)
    return accounts.some((account) => account.credentialRef === credentialRef)
  }

  /**
   * Re-link accounts whose stored owner is unknown (credentials created before
   * accounts were provider-scoped, or with a placeholder id). Only safe when a
   * single Antigravity provider exists — with several we cannot guess which one
   * owns them, so they are left untouched and reported.
   */
  async relinkOrphanedAccounts(knownProviderIds: string[]): Promise<{ relinked: number; orphaned: number }> {
    if (typeof this.credentials.listReferences !== 'function') return { relinked: 0, orphaned: 0 }
    const refs = await this.credentials.listReferences()
    const known = new Set(knownProviderIds)
    let relinked = 0
    let orphaned = 0

    for (const ref of refs) {
      const cred = (await this.credentials.get(ref)) as AntigravityCredential | undefined
      if (!cred || (cred.providerId && known.has(cred.providerId))) continue
      if (knownProviderIds.length !== 1) {
        orphaned++
        continue
      }
      cred.providerId = knownProviderIds[0]
      await this.credentials.set(ref, cred)
      relinked++
    }

    return { relinked, orphaned }
  }

  async getAccessContext(credentialRef: string): Promise<ProviderAccessContext> {
    const credential = (await this.credentials.get(credentialRef)) as AntigravityCredential | undefined
    if (!credential) throw new Error('Antigravity credential not found')
    if (!credential.refreshToken) throw new Error('No refresh token available')

    const bufferMs = 60000
    if (!credential.accessToken || !credential.accessExpiresAt || Date.now() >= credential.accessExpiresAt - bufferMs) {
      const refreshed = await refreshAccessToken(credential.refreshToken)
      credential.accessToken = refreshed.access_token
      credential.accessExpiresAt = Date.now() + refreshed.expires_in * 1000
      await this.credentials.set(credentialRef, credential)
    }

    const arch = process.arch === 'x64' ? 'x64' : 'arm64'
    const uaPlatform = process.platform === 'win32' ? 'win32' : 'darwin'
    const userAgent = `antigravity/${ANTIGRAVITY_VERSION} ${uaPlatform}/${arch}`

    return {
      accessToken: credential.accessToken!,
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': userAgent,
      },
    }
  }

  async getOAuthToken(credentialRef: string): Promise<string> {
    const credential = (await this.credentials.get(credentialRef)) as AntigravityCredential | undefined
    if (!credential?.refreshToken) throw new Error('Refresh token not found')
    return credential.refreshToken
  }

  async getProjectId(credentialRef: string): Promise<string | undefined> {
    const credential = (await this.credentials.get(credentialRef)) as AntigravityCredential | undefined
    return credential?.projectId
  }

  async logout(credentialRef: string): Promise<void> {
    await this.credentials.delete(credentialRef)
  }

  /** Remove every account owned by the deleted provider. */
  async deleteProvider(providerId: string): Promise<void> {
    if (typeof this.credentials.listReferences !== 'function') return
    const refs = await this.credentials.listReferences()
    for (const ref of refs) {
      const cred = (await this.credentials.get(ref)) as AntigravityCredential | undefined
      if (cred && cred.providerId === providerId) {
        await this.credentials.delete(ref)
      }
    }
  }

  async updateAccount(
    credentialRef: string,
    updates: Partial<Pick<AntigravityCredential, 'priority' | 'cost' | 'disabled'>>,
  ): Promise<void> {
    const cred = (await this.credentials.get(credentialRef)) as AntigravityCredential | undefined
    if (!cred) throw new Error(`Account not found: ${credentialRef}`)
    Object.assign(cred, updates)
    await this.credentials.set(credentialRef, cred)
  }
}
