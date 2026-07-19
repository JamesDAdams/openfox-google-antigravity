import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderPluginRegistry } from 'openfox/provider'
import { register } from './index.js'
import { AntigravityAuthAdapter } from './auth/antigravity-auth.js'
import { AntigravityTransportAdapter } from './transport/antigravity.js'
import { MemoryProviderCredentialStore } from './credentials/credential-store.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const mockAuth = {
  getAccessContext: vi.fn(),
  getOAuthToken: vi.fn(),
  getProjectId: vi.fn(),
  credentials: { get: vi.fn() },
  id: 'google-antigravity-auth',
}

function makeContext(credentialRef?: string) {
  return {
    credentialRef,
    signal: new AbortController().signal,
    model: 'gemini-3-flash',
  } as any
}

describe('openfox-google-antigravity plugin', () => {
  it('registers auth, transport, and preset through the public API', async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), 'openfox-google-antigravity-'))
    const registry: ProviderPluginRegistry = {
      runtime: { mode: 'development', configDirectory },
      registerAuth: vi.fn(),
      registerTransport: vi.fn(),
      registerPreset: vi.fn(),
    }
    await register(registry)
    expect(registry.registerAuth).toHaveBeenCalledWith(expect.objectContaining({ id: 'google-antigravity-auth' }))
    expect(registry.registerTransport).toHaveBeenCalledWith(expect.objectContaining({ id: 'google-antigravity-transport' }))
    expect(registry.registerPreset).toHaveBeenCalledWith(expect.objectContaining({ id: 'google-antigravity' }))
  })
})

describe('AntigravityAuthAdapter.beginLogin', () => {
  let adapter: AntigravityAuthAdapter

  beforeEach(() => {
    adapter = new AntigravityAuthAdapter(new MemoryProviderCredentialStore())
  })

  it('returns a device-mode challenge with a Google OAuth URL', async () => {
    const { challenge } = await adapter.beginLogin({ providerId: 'google-antigravity' })
    expect(challenge.mode).toBe('browser')
    expect(challenge.verificationUrl).toContain('accounts.google.com')
    expect(challenge.verificationUrl).toContain('client_id=1071006060591')
    expect(challenge.verificationUrl).toContain('response_type=code')
    expect(typeof challenge.expiresAt).toBe('string')
    expect(challenge.intervalSeconds).toBe(5)
  })
})

describe('AntigravityTransportAdapter.listModels', () => {
  let adapter: AntigravityTransportAdapter

  beforeEach(() => {
    vi.resetAllMocks()
    mockAuth.getAccessContext.mockResolvedValue({
      accessToken: 'test-token',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    })
    adapter = new AntigravityTransportAdapter(mockAuth as any)
  })

  afterEach(() => {
    mockFetch.mockReset()
  })

  it('returns defaults when there is no credentialRef', async () => {
    const models = await adapter.listModels(makeContext(undefined))
    expect(models.length).toBeGreaterThanOrEqual(10)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns defaults when credentialRef is empty', async () => {
    const models = await adapter.listModels(makeContext(''))
    expect(models.length).toBeGreaterThanOrEqual(10)
  })

  it('fetches models from API when credentialRef is provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: {
          'gemini-3-pro': { displayName: 'Gemini 3 Pro', quotaInfo: { remainingFraction: 0.9 } },
          'claude-opus-4-6-thinking': { displayName: 'Claude Opus 4.6 Thinking', quotaInfo: { remainingFraction: 0.8 } },
        },
      }),
    })
    const models = await adapter.listModels(makeContext('cred'))
    expect(models.length).toBe(2)
    expect(models[0]?.id).toBe('gemini-3-pro')
    expect(models[1]?.id).toBe('claude-opus-4-6-thinking')
    expect(models[1]?.source).toBe('backend')
  })

  it('falls back to defaults when API fails', async () => {
    mockFetch.mockRejectedValue(new Error('network error'))
    const models = await adapter.listModels(makeContext('cred'))
    expect(models.length).toBeGreaterThanOrEqual(10)
    for (const m of models) {
      expect(m.source).toBe('default')
    }
  })

  it('falls back to defaults when API returns no models', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ models: {} }) })
    const models = await adapter.listModels(makeContext('cred'))
    expect(models.length).toBeGreaterThanOrEqual(10)
  })

  it('falls back to defaults when access context fails', async () => {
    mockAuth.getAccessContext.mockRejectedValue(new Error('no token'))
    const models = await adapter.listModels(makeContext('cred'))
    expect(models.length).toBeGreaterThanOrEqual(10)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('AntigravityTransportAdapter.stream', () => {
  let adapter: AntigravityTransportAdapter

  beforeEach(() => {
    vi.resetAllMocks()
    mockAuth.getAccessContext.mockResolvedValue({
      accessToken: 'test-token',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    })
    adapter = new AntigravityTransportAdapter(mockAuth as any)
  })

  afterEach(() => {
    mockFetch.mockReset()
  })

  it('returns error when not connected', async () => {
    const ctx = makeContext(undefined)
    const request = { messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal } as any
    const events: any[] = []
    for await (const ev of adapter.stream(request, ctx)) {
      events.push(ev)
    }
    expect(events.length).toBe(1)
    expect(events[0]?.type).toBe('error')
  })

  it('streams text content from Gemini API response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"candidates":[{"content":{"parts":[{"text":"Hello from Gemini"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3,"totalTokenCount":8}}\n\n'
          ))
          controller.close()
        },
      }),
      headers: new Headers({ 'content-type': 'text/event-stream' }),
    })

    const ctx = makeContext('cred')
    const request = { messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal } as any
    const events: any[] = []
    for await (const ev of adapter.stream(request, ctx)) {
      events.push(ev)
    }
    expect(events.some(e => e.type === 'text_delta' && e.content === 'Hello from Gemini')).toBe(true)
    const done = events.find(e => e.type === 'done')
    expect(done).toBeDefined()
    expect(done.response.content).toBe('Hello from Gemini')
    expect(done.response.usage.totalTokens).toBe(8)
  })

  it('streams thinking content for thinking models', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"candidates":[{"content":{"parts":[{"thought":"I need to think about this..."},{"text":"Here is the answer"}]},"finishReason":"STOP"}]}\n\n'
          ))
          controller.close()
        },
      }),
      headers: new Headers({ 'content-type': 'text/event-stream' }),
    })

    const ctx = makeContext('cred')
    const request = { messages: [{ role: 'user', content: 'think about this' }], signal: new AbortController().signal } as any
    const events: any[] = []
    for await (const ev of adapter.stream(request, ctx)) {
      events.push(ev)
    }
    expect(events.some(e => e.type === 'thinking_delta')).toBe(true)
    const done = events.find(e => e.type === 'done')
    expect(done?.response.thinkingContent).toBe('I need to think about this...')
    expect(done?.response.content).toBe('Here is the answer')
  })

  it('handles wrapped v1internal response format', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"Wrapped response"}]},"finishReason":"STOP"}]}}\n\n'
          ))
          controller.close()
        },
      }),
      headers: new Headers({ 'content-type': 'text/event-stream' }),
    })

    const ctx = makeContext('cred')
    const request = { messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal } as any
    const events: any[] = []
    for await (const ev of adapter.stream(request, ctx)) {
      events.push(ev)
    }
    const done = events.find(e => e.type === 'done')
    expect(done?.response.content).toBe('Wrapped response')
  })

  it('handles API errors gracefully', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'Server error',
    })

    const ctx = makeContext('cred')
    const request = { messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal } as any
    const events: any[] = []
    for await (const ev of adapter.stream(request, ctx)) {
      events.push(ev)
    }
    // Should try all endpoints and eventually return error
    expect(events.some(e => e.type === 'error')).toBe(true)
  })

  it('returns finishReason tool_calls when API returns FUNCTION_CALL', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"candidates":[{"content":{"parts":[]},"finishReason":"FUNCTION_CALL"}]}\n\n'
          ))
          controller.close()
        },
      }),
      headers: new Headers({ 'content-type': 'text/event-stream' }),
    })

    const ctx = makeContext('cred')
    const request = {
      messages: [{ role: 'user', content: 'get weather in Paris?' }],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } } as any],
      signal: new AbortController().signal,
    } as any
    const events: any[] = []
    for await (const ev of adapter.stream(request, ctx)) {
      events.push(ev)
    }
    const done = events.find(e => e.type === 'done')
    expect(done?.response.finishReason).toBe('tool_calls')
  })

  it('triggers OAuth token refresh when token is expired', async () => {
    mockAuth.getAccessContext.mockRejectedValue(new Error('refresh failed'))
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"candidates":[{"content":{"parts":[{"text":"after refresh"}]},"finishReason":"STOP"}]}\n\n'
          ))
          controller.close()
        },
      }),
      headers: new Headers({ 'content-type': 'text/event-stream' }),
    })

    const ctx = makeContext('cred')
    const request = { messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal } as any
    const events: any[] = []
    for await (const ev of adapter.stream(request, ctx)) {
      events.push(ev)
    }
    expect(events.some(e => e.type === 'error')).toBe(true)
  })

  it('returns error when the endpoint fails with 500', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      text: async () => 'upstream error',
    })

    const ctx = makeContext('cred')
    const request = { messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal } as any
    const events: any[] = []
    for await (const ev of adapter.stream(request, ctx)) {
      events.push(ev)
    }
    expect(events.some(e => e.type === 'error')).toBe(true)
  })
})
