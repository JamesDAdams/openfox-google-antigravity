import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_CLIENT_SECRET, ANTIGRAVITY_SCOPES, ANTIGRAVITY_REDIRECT_PORT, ANTIGRAVITY_ENDPOINTS, ANTIGRAVITY_DEFAULT_PROJECT_ID } from '../constants.js'

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

export function generatePKCE() {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export function buildAuthUrl(challenge: string, verifier: string, port = ANTIGRAVITY_REDIRECT_PORT): string {
  const state = base64url(Buffer.from(JSON.stringify({ verifier })))
  const redirectUri = `http://localhost:${port}/oauth-callback`
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', ANTIGRAVITY_CLIENT_ID)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', ANTIGRAVITY_SCOPES.join(' '))
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('state', state)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  return url.toString()
}

export interface OAuthCallbackResult {
  code: string
  state: string
}

export function startOAuthServer(port = ANTIGRAVITY_REDIRECT_PORT, timeoutMs = 180000): Promise<OAuthCallbackResult> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId)
      server.close()
    }

    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`)
      if (url.pathname === '/oauth-callback') {
        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')
        if (code && state) {
          res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><body style="font-family:sans-serif;text-align:center;padding-top:50px"><h2>Authentication successful!</h2><p>You can close this tab and return to OpenFox.</p></body></html>')
          cleanup()
          resolve({ code, state })
        } else {
          res.writeHead(400).end('Missing code or state')
        }
      } else {
        res.writeHead(404).end('Not Found')
      }
    })

    server.listen(port, '127.0.0.1', () => {
      timeoutId = setTimeout(() => {
        cleanup()
        reject(new Error('OAuth authorization timed out'))
      }, timeoutMs)
    })

    server.on('error', (err: NodeJS.ErrnoException) => {
      cleanup()
      reject(err)
    })
  })
}

export interface TokenResponse {
  access_token: string
  expires_in: number
  refresh_token: string
}

export async function exchangeCode(code: string, verifier: string, port = ANTIGRAVITY_REDIRECT_PORT): Promise<TokenResponse> {
  const redirectUri = `http://localhost:${port}/oauth-callback`
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  })
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`)
  return res.json() as Promise<TokenResponse>
}

export interface RefreshTokenResponse {
  access_token: string
  expires_in: number
}

export async function refreshAccessToken(refreshToken: string): Promise<RefreshTokenResponse> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: ANTIGRAVITY_CLIENT_ID,
      client_secret: ANTIGRAVITY_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`)
  return res.json() as Promise<RefreshTokenResponse>
}

export async function fetchUserEmail(accessToken: string): Promise<string | undefined> {
  const res = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) return undefined
  const data = await res.json() as { email?: string }
  return data.email
}

export async function fetchProjectId(accessToken: string): Promise<string> {
  for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
    try {
      const res = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'OpenFox',
        },
        body: JSON.stringify({
          metadata: {
            ideType: 'ANTIGRAVITY',
            platform: 'PLATFORM_UNSPECIFIED',
            pluginType: 'GEMINI',
          },
        }),
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok) {
        const data = await res.json() as { cloudaicompanionProject?: string | { id?: string } }
        if (typeof data.cloudaicompanionProject === 'string' && data.cloudaicompanionProject) return data.cloudaicompanionProject
        if (data.cloudaicompanionProject && typeof data.cloudaicompanionProject === 'object' && 'id' in data.cloudaicompanionProject) return (data.cloudaicompanionProject as { id: string }).id
      }
    } catch { /* try next */ }
  }
  return ANTIGRAVITY_DEFAULT_PROJECT_ID
}
