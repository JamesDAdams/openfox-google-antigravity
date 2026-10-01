import { describe, it, expect, vi, afterEach } from 'vitest'

const undiciFetch = vi.fn()
const agentCtor = vi.fn()

vi.mock('undici', () => ({
  fetch: undiciFetch,
  EnvHttpProxyAgent: class {
    constructor() {
      agentCtor()
    }
  },
}))

describe('proxyFetch', () => {
  const saved = { ...process.env }

  afterEach(() => {
    process.env = { ...saved }
    undiciFetch.mockReset()
    agentCtor.mockReset()
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('routes through undici with a proxy agent when a proxy env var is set', async () => {
    process.env['HTTPS_PROXY'] = 'http://localhost:9000'
    undiciFetch.mockResolvedValue(new Response('ok'))
    const { proxyFetch } = await import('./net.js')

    await proxyFetch('https://oauth2.googleapis.com/token', { method: 'POST' })

    expect(agentCtor).toHaveBeenCalledTimes(1)
    expect(undiciFetch).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/token',
      expect.objectContaining({ method: 'POST', dispatcher: expect.anything() }),
    )
  })

  it('uses the global fetch when no proxy env var is set', async () => {
    delete process.env['HTTPS_PROXY']
    delete process.env['https_proxy']
    delete process.env['HTTP_PROXY']
    delete process.env['http_proxy']
    const globalFetch = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', globalFetch)
    const { proxyFetch } = await import('./net.js')

    await proxyFetch('https://example.com')

    expect(globalFetch).toHaveBeenCalledTimes(1)
    expect(undiciFetch).not.toHaveBeenCalled()
  })
})
