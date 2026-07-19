import type { ProviderAccessContext, ProviderAuthAdapter, ProviderAuthStatus, ProviderLoginChallenge } from 'openfox/provider'
import type { ProviderCredentialStore } from '../credentials/credential-store.js'
import { generatePKCE, buildAuthUrl, startOAuthServer, exchangeCode, refreshAccessToken, fetchUserEmail, fetchProjectId } from './google-oauth.js'

export interface AntigravityCredential {
  refreshToken: string
  accessToken?: string
  accessExpiresAt?: number
  email?: string
  projectId?: string
}

export class AntigravityAuthAdapter implements ProviderAuthAdapter {
  readonly id = 'google-antigravity-auth'
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

        const credential: AntigravityCredential = {
          refreshToken: tokens.refresh_token,
          accessToken: tokens.access_token,
          accessExpiresAt: Date.now() + tokens.expires_in * 1000,
          email,
          projectId,
        }

        const credentialRef = await this.credentials.create(credential)
        console.log('[openfox-google-antigravity] Credential saved:', credentialRef)
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

  async getStatus(context: { providerId: string; credentialRef?: string }): Promise<ProviderAuthStatus> {
    if (!context.credentialRef) return { state: 'disconnected' }

    const credential = await this.credentials.get(context.credentialRef) as AntigravityCredential | undefined
    if (!credential) return { state: 'disconnected' }

    if (credential.refreshToken) {
      return { state: 'connected', accountLabel: credential.email ?? 'Google Account' }
    }

    return { state: 'expired', accountLabel: credential.email, error: 'No refresh token available' }
  }

  async getAccessContext(credentialRef: string): Promise<ProviderAccessContext> {
    const credential = await this.credentials.get(credentialRef) as AntigravityCredential | undefined
    if (!credential) throw new Error('Antigravity credential not found')
    if (!credential.refreshToken) throw new Error('No refresh token available')

    const bufferMs = 60000
    if (!credential.accessToken || !credential.accessExpiresAt || Date.now() >= credential.accessExpiresAt - bufferMs) {
      const refreshed = await refreshAccessToken(credential.refreshToken)
      credential.accessToken = refreshed.access_token
      credential.accessExpiresAt = Date.now() + refreshed.expires_in * 1000
      await this.credentials.set(credentialRef, credential)
    }

    const platform = process.platform === 'win32' ? 'win32' : 'darwin'
    const arch = process.arch === 'x64' ? 'x64' : 'arm64'
    const userAgent = `antigravity/2.0.6 ${platform}/${arch}`

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
    const credential = await this.credentials.get(credentialRef) as AntigravityCredential | undefined
    if (!credential?.refreshToken) throw new Error('Refresh token not found')
    return credential.refreshToken
  }

  async getProjectId(credentialRef: string): Promise<string | undefined> {
    const credential = await this.credentials.get(credentialRef) as AntigravityCredential | undefined
    return credential?.projectId
  }

  async logout(credentialRef: string): Promise<void> {
    await this.credentials.delete(credentialRef)
  }
}
