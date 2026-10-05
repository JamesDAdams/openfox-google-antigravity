import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderPluginRegistry } from 'openfox/provider'
import { register } from './index.js'
import { AntigravityAuthAdapter } from './auth/antigravity-auth.js'
import { AntigravityTransportAdapter } from './transport/antigravity.js'
import { MemoryProviderCredentialStore } from './credentials/credential-store.js'
import { FileProviderCredentialStore } from './credentials/file-credential-store.js'
import { getDefaultModels } from './catalog/models-default.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const mockAuth = {
  getAccessContext: vi.fn(),
  getOAuthToken: vi.fn(),
  getProjectId: vi.fn(),
  credentials: { get: vi.fn() },
  id: 'google-antigravity-auth',
}

function makeContext(credentialRef?: string, model = 'gemini-3-flash') {
  return {
    credentialRef,
    signal: new AbortController().signal,
    model,
  } as any
}

describe('openfox-google-antigravity plugin', () => {
  it('registers auth, transport, preset, and settings through the public API', async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), 'openfox-google-antigravity-'))
    const registry: ProviderPluginRegistry = {
      runtime: { mode: 'development', configDirectory },
      registerAuth: vi.fn(),
      registerTransport: vi.fn(),
      registerPreset: vi.fn(),
      registerSettings: vi.fn(),
    } as any
    await register(registry)
    expect(registry.registerAuth).toHaveBeenCalledWith(expect.objectContaining({ id: 'google-antigravity-auth' }))
    expect(registry.registerTransport).toHaveBeenCalledWith(expect.objectContaining({ id: 'google-antigravity-transport' }))
    expect(registry.registerPreset).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'google-antigravity',
        defaults: expect.objectContaining({
          models: expect.arrayContaining([
            expect.objectContaining({ id: 'gemini-3.8-flash-tiered' }),
            expect.objectContaining({ id: 'gemini-3.6-flash', reasoningEfforts: ['low', 'medium', 'high'] }),
            expect.objectContaining({ id: 'gemini-3.1-pro', reasoningEfforts: ['low', 'high'] }),
          ]),
        }),
      }),
    )
    const preset = (registry.registerPreset as any).mock.calls[0]?.[0]
    for (const model of preset.defaults.models) {
      expect(model.modes).toBeUndefined()
    }
    expect(registry.registerSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        fields: expect.arrayContaining([
          expect.objectContaining({
            key: 'modelsConfig',
            type: 'textarea',
          }),
          expect.objectContaining({
            key: 'mergeSubscriptions',
            type: 'boolean',
            default: true,
          }),
        ]),
      }),
    )
  })

  it('registers quota provider, RPCs, and hook when available', async () => {
    const configDirectory = await mkdtemp(join(tmpdir(), 'openfox-google-antigravity-'))
    const rpcs: Record<string, Function> = {}
    let registeredHook: any

    const registry: any = {
      runtime: { mode: 'development', configDirectory },
      registerAuth: vi.fn(),
      registerTransport: vi.fn(),
      registerPreset: vi.fn(),
      registerQuotaProvider: vi.fn(),
      registerRpc: vi.fn((method, handler) => {
        rpcs[method] = handler
      }),
      registerTool: vi.fn(),
      registerHook: vi.fn((event, handler) => {
        if (event === 'turn.completed') registeredHook = handler
      }),
    }

    await register(registry)
    expect(registry.registerQuotaProvider).toHaveBeenCalledWith(expect.objectContaining({ id: 'google-antigravity' }))
    expect(registry.registerRpc).toHaveBeenCalledWith('antigravity.getQuota', expect.any(Function))
    expect(registry.registerRpc).toHaveBeenCalledWith('antigravity.syncQuota', expect.any(Function))
    expect(registry.registerHook).toHaveBeenCalledWith('turn.completed', expect.any(Function))

    // Test getQuota RPC
    const quotaResult = await rpcs['antigravity.getQuota']?.({})
    expect(quotaResult?.sources).toBeDefined()

    // Test syncQuota RPC
    const syncResult = await rpcs['antigravity.syncQuota']?.()
    expect(syncResult?.success).toBe(true)

    // Test hook execution
    await expect(registeredHook?.()).resolves.toBeUndefined()
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
  let mockGetSettings: any
  let mockLogger: any

  beforeEach(() => {
    vi.resetAllMocks()
    mockAuth.getAccessContext.mockResolvedValue({
      accessToken: 'test-token',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    })
    mockGetSettings = vi.fn(() => ({}))
    mockLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
    adapter = new AntigravityTransportAdapter(mockAuth as any, mockGetSettings, mockLogger)
  })

  afterEach(() => {
    mockFetch.mockReset()
  })

  it('returns defaults when there is no credentialRef', async () => {
    const models = await adapter.listModels(makeContext(undefined))
    expect(models.length).toBe(7)
    expect(models.map((m) => m.id)).toEqual([
      'gemini-3.8-flash-tiered',
      'gemini-3.7-flash-tiered',
      'gemini-3.6-flash',
      'gemini-3.1-pro',
      'claude-sonnet-4-6',
      'claude-opus-4-6-thinking',
      'gpt-oss-120b-medium',
    ])
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('returns defaults when credentialRef is empty', async () => {
    const models = await adapter.listModels(makeContext(''))
    expect(models.length).toBe(7)
  })

  it('reads custom modelsConfig from settings', async () => {
    mockGetSettings.mockReturnValue({
      modelsConfig: JSON.stringify([
        { id: 'custom-model', name: 'Custom Model', contextWindow: 500000, supportsVision: true },
      ]),
    })
    const models = await adapter.listModels(makeContext(undefined))
    expect(models.length).toBe(1)
    expect(models[0]).toMatchObject({ id: 'custom-model', name: 'Custom Model', contextWindow: 500000 })
  })

  it('falls back to default models and logs a warning when modelsConfig has invalid JSON', async () => {
    mockGetSettings.mockReturnValue({ modelsConfig: 'invalid-json{' })
    const models = await adapter.listModels(makeContext(undefined))
    expect(models.length).toBe(7)
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Invalid modelsConfig JSON'),
      expect.any(Object),
    )
  })

  it('fetches models from API and enriches configured models with capabilities', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: {
          'gemini-3.8-flash-tiered': {
            maxTokens: 1048576,
            maxOutputTokens: 65536,
            supportsImages: true,
          },
          'gemini-3.1-pro-low': {
            maxTokens: 1048576,
            supportsImages: true,
          },
          'claude-sonnet-4-6': {
            maxTokens: 250000,
            supportsImages: true,
          },
        },
      }),
    })
    const models = await adapter.listModels(makeContext('cred'))
    expect(models.length).toBe(7)
    const flash38 = models.find((m) => m.id === 'gemini-3.8-flash-tiered')
    expect(flash38).toMatchObject({
      id: 'gemini-3.8-flash-tiered',
      name: 'Gemini 3.8 Flash',
      contextWindow: 1048576,
      supportsVision: true,
      source: 'backend',
    })
    const pro31 = models.find((m) => m.id === 'gemini-3.1-pro')
    expect(pro31?.source).toBe('backend')
    expect(pro31?.contextWindow).toBe(1048576)
  })

  it('shipped defaults carry the 7 Antigravity families with reasoning efforts and no mode variants', () => {
    const defaults = getDefaultModels()
    expect(defaults.length).toBe(7)
    const byId = new Map(defaults.map((m) => [m.id, m]))

    expect(byId.get('gemini-3.8-flash-tiered')).toMatchObject({
      name: 'Gemini 3.8 Flash',
      contextWindow: 1048576,
      supportsVision: true,
      reasoningEfforts: ['low', 'medium', 'high'],
      thinkingLevel: 'high',
    })

    expect(byId.get('gemini-3.6-flash')).toMatchObject({
      name: 'Gemini 3.6 Flash',
      contextWindow: 1048576,
      supportsVision: true,
      reasoningEfforts: ['low', 'medium', 'high'],
      thinkingLevel: 'medium',
    })

    expect(byId.get('gemini-3.1-pro')).toMatchObject({
      name: 'Gemini 3.1 Pro',
      contextWindow: 1048576,
      supportsVision: true,
      reasoningEfforts: ['low', 'high'],
      thinkingLevel: 'low',
    })

    expect(byId.get('claude-sonnet-4-6')).toMatchObject({ contextWindow: 250000, supportsVision: true })
    expect(byId.get('gpt-oss-120b-medium')).toMatchObject({ contextWindow: 131072, supportsVision: false })

    for (const model of defaults) {
      expect(model.modes).toBeUndefined()
    }
  })

  it('never exposes mode variants to the core, even when modelsConfig still carries modes', async () => {
    mockGetSettings.mockReturnValue({
      modelsConfig: JSON.stringify([
        {
          id: 'gemini-3.6-flash',
          name: 'Gemini 3.6 Flash',
          contextWindow: 1048576,
          supportsVision: true,
          reasoningEfforts: ['low', 'medium', 'high'],
          modes: [
            { level: 'low', apiModelId: 'gemini-3.6-flash-low' },
            { level: 'medium', apiModelId: 'gemini-3.6-flash-medium' },
            { level: 'high', apiModelId: 'gemini-3.6-flash-high' },
          ],
        },
      ]),
    })
    const models = await adapter.listModels(makeContext(undefined))
    expect(models.length).toBe(1)
    expect(models[0]?.id).toBe('gemini-3.6-flash')
    expect(models[0]?.modes).toBeUndefined()
    expect(models[0]?.reasoningEfforts).toEqual(['low', 'medium', 'high'])
  })

  it('enriches families through their mapped mode ids when the base id is absent from the catalog', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: {
          'gemini-3.6-flash-high': { maxTokens: 2097152, supportsImages: true },
          'gemini-3.1-pro-low': { maxTokens: 524288, supportsImages: false },
        },
      }),
    })
    const models = await adapter.listModels(makeContext('cred'))
    const flash36 = models.find((m) => m.id === 'gemini-3.6-flash')
    expect(flash36?.contextWindow).toBe(2097152)
    expect(flash36?.supportsVision).toBe(true)
    expect(flash36?.source).toBe('backend')
    const pro31 = models.find((m) => m.id === 'gemini-3.1-pro')
    expect(pro31?.contextWindow).toBe(524288)
    expect(pro31?.source).toBe('backend')
  })

  it('falls back to defaults when API fails', async () => {
    mockFetch.mockRejectedValue(new Error('network error'))
    const models = await adapter.listModels(makeContext('cred'))
    expect(models.length).toBe(7)
    for (const m of models) {
      expect(m.source).toBe('default')
    }
  })

  it('falls back to defaults when API returns no models', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ models: {} }) })
    const models = await adapter.listModels(makeContext('cred'))
    expect(models.length).toBe(7)
  })

  it('falls back to defaults when access context fails', async () => {
    mockAuth.getAccessContext.mockRejectedValue(new Error('no token'))
    const models = await adapter.listModels(makeContext('cred'))
    expect(models.length).toBe(7)
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

  it('sends only the envelope fields the content endpoint accepts', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n'
          ))
          controller.close()
        },
      }),
      headers: new Headers({ 'content-type': 'text/event-stream' }),
    })

    const ctx = makeContext('cred')
    const request = { messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal } as any
    for await (const _ev of adapter.stream(request, ctx)) {
      // drain
    }

    const call = mockFetch.mock.calls[0]
    const body = JSON.parse((call?.[1] as RequestInit).body as string)
    expect(Object.keys(body).sort()).toEqual(['model', 'project', 'request', 'requestId', 'requestType', 'userAgent'])
  })

  it('sends thinkingLevel for Gemini 3 models with reasoningEffort', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n'
          ))
          controller.close()
        },
      }),
      headers: new Headers({ 'content-type': 'text/event-stream' }),
    })

    const ctx = makeContext('cred', 'gemini-3-flash')
    const request = {
      messages: [{ role: 'user', content: 'hi' }],
      reasoningEffort: 'high',
      signal: new AbortController().signal,
    } as any
    for await (const _ev of adapter.stream(request, ctx)) {
      // drain
    }

    const call = mockFetch.mock.calls[0]
    const body = JSON.parse((call?.[1] as RequestInit).body as string)
    expect(body.request.generationConfig.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: 'high',
    })
  })

  it('sends the catalog mode id for families whose base id is not a catalog model', async () => {
    const cases: Array<[string, string, string]> = [
      ['gemini-3.6-flash', 'low', 'gemini-3.6-flash-low'],
      ['gemini-3.6-flash', 'medium', 'gemini-3.6-flash-medium'],
      ['gemini-3.6-flash', 'high', 'gemini-3.6-flash-high'],
      ['gemini-3.1-pro', 'low', 'gemini-3.1-pro-low'],
      ['gemini-3.1-pro', 'high', 'gemini-pro-agent'],
    ]

    for (const [model, effort, expected] of cases) {
      mockFetch.mockReset()
      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(
              'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n'
            ))
            controller.close()
          },
        }),
        headers: new Headers({ 'content-type': 'text/event-stream' }),
      })

      const request = {
        messages: [{ role: 'user', content: 'hi' }],
        reasoningEffort: effort,
        signal: new AbortController().signal,
      } as any
      for await (const _ev of adapter.stream(request, makeContext('cred', model))) {
        // drain
      }

      const body = JSON.parse((mockFetch.mock.calls[0]?.[1] as RequestInit).body as string)
      expect(body.model, `${model} + ${effort}`).toBe(expected)
      expect(body.request.generationConfig.thinkingConfig, `${model} + ${effort}`).toBeUndefined()
    }
  })

  it('falls back to the model default effort when no reasoningEffort is provided', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n'
          ))
          controller.close()
        },
      }),
      headers: new Headers({ 'content-type': 'text/event-stream' }),
    })

    const request = { messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal } as any
    for await (const _ev of adapter.stream(request, makeContext('cred', 'gemini-3.6-flash'))) {
      // drain
    }

    const body = JSON.parse((mockFetch.mock.calls[0]?.[1] as RequestInit).body as string)
    expect(body.model).toBe('gemini-3.6-flash-medium')
  })

  it('sends the tiered ids unchanged since the catalog has no per-effort variant for 3.7 (low would 404)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n'
          ))
          controller.close()
        },
      }),
      headers: new Headers({ 'content-type': 'text/event-stream' }),
    })

    const request = { messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'low', signal: new AbortController().signal } as any
    for await (const _ev of adapter.stream(request, makeContext('cred', 'gemini-3.7-flash-tiered'))) {
      // drain
    }

    const body = JSON.parse((mockFetch.mock.calls[0]?.[1] as RequestInit).body as string)
    expect(body.model).toBe('gemini-3.7-flash-tiered')
  })

  it('sends gemini-3.8-flash-tiered unchanged whatever the reasoning effort', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n'
          ))
          controller.close()
        },
      }),
      headers: new Headers({ 'content-type': 'text/event-stream' }),
    })

    const request = { messages: [{ role: 'user', content: 'hi' }], reasoningEffort: 'high', signal: new AbortController().signal } as any
    for await (const _ev of adapter.stream(request, makeContext('cred', 'gemini-3.8-flash-tiered'))) {
      // drain
    }

    const body = JSON.parse((mockFetch.mock.calls[0]?.[1] as RequestInit).body as string)
    expect(body.model).toBe('gemini-3.8-flash-tiered')
  })

  it('handles API error payload in SSE data stream', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"error":{"code":400,"message":"Model not supported"}}\n\n'
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
    const errEvent = events.find(e => e.type === 'error')
    expect(errEvent).toBeDefined()
    expect(errEvent?.error).toContain('Model not supported')
  })

  it('sends thinking_budget for Claude models with reasoningEffort', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n'
          ))
          controller.close()
        },
      }),
      headers: new Headers({ 'content-type': 'text/event-stream' }),
    })

    const ctx = makeContext('cred', 'claude-sonnet-4-6')
    const request = {
      messages: [{ role: 'user', content: 'hi' }],
      reasoningEffort: 'medium',
      signal: new AbortController().signal,
    } as any
    for await (const _ev of adapter.stream(request, ctx)) {
      // drain
    }

    const call = mockFetch.mock.calls[0]
    const body = JSON.parse((call?.[1] as RequestInit).body as string)
    expect(body.request.generationConfig.thinkingConfig).toEqual({
      include_thoughts: true,
      thinking_budget: 16384,
    })
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

  it('isolates accounts per providerId and cascades deletion on provider delete', async () => {
    const store = new MemoryProviderCredentialStore()
    const authAdapter = new AntigravityAuthAdapter(store)

    // Add credentials for provider 1
    const ref1 = await store.create({
      providerId: 'provider-1',
      refreshToken: 'token-1',
      email: 'user1@example.com',
      projectId: 'proj-1',
    })
    const ref2 = await store.create({
      providerId: 'provider-1',
      refreshToken: 'token-2',
      email: 'user2@example.com',
      projectId: 'proj-1',
    })

    // Add credential for provider 2
    const ref3 = await store.create({
      providerId: 'provider-2',
      refreshToken: 'token-3',
      email: 'user3@example.com',
      projectId: 'proj-2',
    })

    // List accounts for provider 1: must only see provider 1 accounts
    const p1Accounts = await authAdapter.listAccounts('provider-1')
    expect(p1Accounts).toHaveLength(2)
    expect(p1Accounts.map(a => a.email)).toEqual(['user1@example.com', 'user2@example.com'])

    // List accounts for provider 2: must only see provider 2 accounts
    const p2Accounts = await authAdapter.listAccounts('provider-2')
    expect(p2Accounts).toHaveLength(1)
    expect(p2Accounts[0]?.email).toBe('user3@example.com')

    // Single account removal (removeAccount via logout)
    await authAdapter.logout(ref1)
    const p1AccountsAfterRemove = await authAdapter.listAccounts('provider-1')
    expect(p1AccountsAfterRemove).toHaveLength(1)
    expect(p1AccountsAfterRemove[0]?.email).toBe('user2@example.com')

    // Cascade delete provider 1: removes all accounts of provider 1, keeps provider 2 intact
    await authAdapter.deleteProvider('provider-1')
    expect(await authAdapter.listAccounts('provider-1')).toHaveLength(0)
    expect(await authAdapter.listAccounts('provider-2')).toHaveLength(1)
  })
})

describe('account ownership and auth UI', () => {
  async function setupPlugin() {
    const configDirectory = await mkdtemp(join(tmpdir(), 'openfox-google-antigravity-'))
    const storageDir = join(configDirectory, 'plugins', 'openfox-google-antigravity')
    const store = new FileProviderCredentialStore(
      join(storageDir, 'credentials.json'),
      join(storageDir, 'credentials.key'),
    )
    const p1Ref = await store.create({
      providerId: 'provider-1',
      refreshToken: 'token-1',
      email: 'user1@example.com',
      projectId: 'proj-1',
    })
    await store.create({
      providerId: 'provider-2',
      refreshToken: 'token-2',
      email: 'user2@example.com',
      projectId: 'proj-2',
    })
    const legacyRef = await store.create({ refreshToken: 'token-legacy', email: 'legacy@example.com' })

    const rpcs: Record<string, (params: any, context?: any) => Promise<any>> = {}
    let uiOverride: any
    const publish = vi.fn()
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const registry: any = {
      runtime: { mode: 'development', configDirectory },
      context: { id: 'openfox-google-antigravity', logger, settings: () => ({}), publish },
      registerAuth: vi.fn(),
      registerTransport: vi.fn(),
      registerPreset: vi.fn(),
      registerQuotaProvider: vi.fn(),
      registerRpc: vi.fn((method: string, handler: any) => {
        rpcs[method] = handler
      }),
      registerUiOverride: vi.fn((override: any) => {
        uiOverride = override
      }),
      registerTool: vi.fn(),
      registerHook: vi.fn(),
    }

    await register(registry)
    return { configDirectory, store, p1Ref, legacyRef, rpcs, publish, logger, uiOverride, getOverride: () => uiOverride }
  }

  it('never lists accounts without a provider id and never leaks another provider accounts', async () => {
    const store = new MemoryProviderCredentialStore()
    const auth = new AntigravityAuthAdapter(store)
    await store.create({ providerId: 'provider-1', refreshToken: 't1', email: 'user1@example.com' })
    await store.create({ refreshToken: 'legacy', email: 'legacy@example.com' })

    expect(await auth.listAccounts()).toHaveLength(0)
    expect(await auth.listAccounts('provider-2')).toHaveLength(0)
    const p1 = await auth.listAccounts('provider-1')
    expect(p1.map((account) => account.email)).toEqual(['user1@example.com'])
  })

  it('re-links orphaned credentials when a single provider owns the plugin', async () => {
    const store = new MemoryProviderCredentialStore()
    const auth = new AntigravityAuthAdapter(store)
    const ref = await store.create({ refreshToken: 'legacy', email: 'legacy@example.com' })
    await store.create({ providerId: 'gone-provider', refreshToken: 't', email: 'orphan@example.com' })

    const result = await auth.relinkOrphanedAccounts(['provider-1'])

    expect(result).toEqual({ relinked: 2, orphaned: 0 })
    expect(await auth.listAccounts('provider-1')).toHaveLength(2)
    expect((await store.get(ref) as { providerId?: string }).providerId).toBe('provider-1')
  })

  it('leaves orphaned credentials untouched when several providers exist', async () => {
    const store = new MemoryProviderCredentialStore()
    const auth = new AntigravityAuthAdapter(store)
    await store.create({ refreshToken: 'legacy', email: 'legacy@example.com' })

    const result = await auth.relinkOrphanedAccounts(['provider-1', 'provider-2'])

    expect(result).toEqual({ relinked: 0, orphaned: 1 })
    expect(await auth.listAccounts('provider-1')).toHaveLength(0)
    expect(await auth.listAccounts('provider-2')).toHaveLength(0)
  })

  it('serves the auth UI from the live content source instead of a load-time snapshot', async () => {
    const { uiOverride } = await setupPlugin()

    expect(uiOverride?.zone).toBe('provider.modal.auth')
    expect(uiOverride?.contentSource).toEqual({ kind: 'rpc', method: 'antigravity.getAuthUi', refreshMs: 3000 })
    // The static shell must never carry another provider's accounts.
    expect(JSON.stringify(uiOverride?.replacement)).not.toContain('user1@example.com')
    expect(JSON.stringify(uiOverride?.replacement)).not.toContain('user2@example.com')
  })

  it('scopes the auth UI content to the provider asked for', async () => {
    const { rpcs } = await setupPlugin()

    const p1 = await rpcs['antigravity.getAuthUi']?.({ providerId: 'provider-1' })
    expect(JSON.stringify(p1?.content)).toContain('user1@example.com')
    expect(JSON.stringify(p1?.content)).not.toContain('user2@example.com')

    const p2 = await rpcs['antigravity.getAuthUi']?.({ providerId: 'provider-2' })
    expect(JSON.stringify(p2?.content)).toContain('user2@example.com')
    expect(JSON.stringify(p2?.content)).not.toContain('user1@example.com')

    const none = await rpcs['antigravity.getAuthUi']?.({})
    expect(JSON.stringify(none?.content)).not.toContain('user1@example.com')
    expect(JSON.stringify(none?.content)).not.toContain('user2@example.com')
  })

  it('refuses to add an account without a provider id', async () => {
    const { rpcs } = await setupPlugin()

    const result = await rpcs['antigravity.addAccount']?.({})

    expect(result?.success).toBe(false)
    expect(result?.error).toContain('providerId')
  })

  it('refuses to remove an account owned by another provider', async () => {
    const { rpcs, store } = await setupPlugin()
    const p1Accounts = await rpcs['antigravity.listAccounts']?.({ providerId: 'provider-1' })

    const result = await rpcs['antigravity.removeAccount']?.({
      providerId: 'provider-2',
      credentialRef: p1Accounts?.accounts?.[0]?.credentialRef,
    })

    expect(result?.success).toBe(false)
    expect(await store.get(p1Accounts?.accounts?.[0]?.credentialRef)).toBeDefined()
  })

  it('removes the account and publishes the refreshed list for its provider', async () => {
    const { rpcs, store, publish } = await setupPlugin()
    const p1Accounts = await rpcs['antigravity.listAccounts']?.({ providerId: 'provider-1' })
    const credentialRef = p1Accounts?.accounts?.[0]?.credentialRef

    const result = await rpcs['antigravity.removeAccount']?.({ providerId: 'provider-1', credentialRef })

    expect(result?.success).toBe(true)
    expect(await store.get(credentialRef)).toBeUndefined()
    expect(publish).toHaveBeenCalledWith(undefined, 'content', expect.anything())
    const published = JSON.stringify(publish.mock.calls[publish.mock.calls.length - 1]?.[2])
    expect(published).not.toContain('user1@example.com')
    expect(published).not.toContain('user2@example.com')
  })

  it('keeps quota discovery working for accounts of every provider', async () => {
    const { rpcs } = await setupPlugin()

    const sources = await rpcs['antigravity.getQuota']?.({})

    expect(sources?.sources?.length).toBeGreaterThan(0)
  })

  it('renders full width cards and handles account reordering with priority', async () => {
    const { rpcs, store, publish } = await setupPlugin()
    // Add a second account to provider-1
    await store.create({
      providerId: 'provider-1',
      refreshToken: 't1-b',
      email: 'user1b@example.com',
      priority: 1,
    })

    const ui = await rpcs['antigravity.getAuthUi']?.({ providerId: 'provider-1' })
    expect(ui.content.className).toContain('w-full')
    expect(ui.content.align).toBe('stretch')

    const accountsStack = ui.content.children.find((c: any) => c.children?.some((child: any) => child.type === 'card'))
    expect(accountsStack.className).toContain('w-full')
    expect(accountsStack.align).toBe('stretch')
    const cards = accountsStack.children.filter((c: any) => c.type === 'card')
    expect(cards).toHaveLength(2)
    expect(cards[0].className).toContain('w-full')

    // First card should have up button disabled, second card down button disabled
    const firstButtons = cards[0].children[0].children[1].children
    const secondButtons = cards[1].children[0].children[1].children
    const firstUp = firstButtons.find((b: any) => b.label?.en === '↑')
    const firstDown = firstButtons.find((b: any) => b.label?.en === '↓')
    const secondUp = secondButtons.find((b: any) => b.label?.en === '↑')
    const secondDown = secondButtons.find((b: any) => b.label?.en === '↓')

    expect(firstUp.disabled).toBe(true)
    expect(firstDown.disabled).toBe(false)
    expect(secondUp.disabled).toBe(false)
    expect(secondDown.disabled).toBe(true)

    // Each card should have a Reconnect button and a Remove button
    const firstReconnect = firstButtons.find((b: any) => b.label?.en === 'Reconnect')
    const firstRemove = firstButtons.find((b: any) => b.label?.en === 'Remove')
    expect(firstReconnect).toBeDefined()
    expect(firstRemove).toBeDefined()

    // Reorder: move second account up
    const listBefore = await rpcs['antigravity.listAccounts']?.({ providerId: 'provider-1' })
    const secondRef = listBefore.accounts[1].credentialRef
    const reorderRes = await rpcs['antigravity.reorderAccount']?.({
      providerId: 'provider-1',
      credentialRef: secondRef,
      direction: 'up',
    })
    expect(reorderRes.success).toBe(true)

    // Check new order in listAccounts
    const listAfter = await rpcs['antigravity.listAccounts']?.({ providerId: 'provider-1' })
    expect(listAfter.accounts[0].email).toBe('user1b@example.com')
    expect(listAfter.accounts[1].email).toBe('user1@example.com')
    expect(listAfter.accounts[0].priority).toBe(0)
    expect(listAfter.accounts[1].priority).toBe(1)
    expect(publish).toHaveBeenCalledWith(undefined, 'content', expect.anything())
  })

  it('displays a loading callout and disables connect button during authentication', async () => {
    const { buildDeclarativeAuthComponent } = await import('./ui.js')
    const ui: any = buildDeclarativeAuthComponent([], {}, 'provider-1', true)

    const loadingCallout = ui.children.find((c: any) => c.type === 'callout' && c.tone === 'warning')
    expect(loadingCallout).toBeDefined()
    expect(loadingCallout.title?.en).toContain('Connecting')

    const actionStack = ui.children.find((c: any) => c.type === 'stack' && c.children?.some((child: any) => child.label?.en?.includes('Connecting')))
    const connectButton = actionStack?.children?.[0]
    expect(connectButton.disabled).toBe(true)
    expect(connectButton.label?.en).toContain('Connecting')
  })

  it('renders dynamic account status labels for quota exceeded and verification required', async () => {
    const { buildDeclarativeAuthComponent } = await import('./ui.js')
    const ui: any = buildDeclarativeAuthComponent(
      [
        { credentialRef: 'c1', email: 'u1@test.com', status: 'connected' },
        { credentialRef: 'c2', email: 'u2@test.com', status: 'quota_exceeded' },
        { credentialRef: 'c3', email: 'u3@test.com', status: 'verification_required' },
        { credentialRef: 'c4', email: 'u4@test.com', status: 'expired' },
      ],
      {},
      'provider-1',
      false,
    )

    const cards = ui.children
      .find((c: any) => c.children?.some((child: any) => child.type === 'card'))
      ?.children.filter((c: any) => c.type === 'card')
    expect(cards).toHaveLength(4)

    const status1 = cards[0].children[0].children[0].children[1].children[1]
    const status2 = cards[1].children[0].children[0].children[1].children[1]
    const status3 = cards[2].children[0].children[0].children[1].children[1]
    const status4 = cards[3].children[0].children[0].children[1].children[1]

    expect(status1.text.en).toBe('Connected ✓')
    expect(status2.text.en).toBe('Quota Exceeded (429)')
    expect(status3.text.en).toBe('Verification Required (403)')
    expect(status4.text.en).toBe('Disconnected / Expired')
  })
})

describe('provider-scoped account routing', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('routes a request only to the accounts of the requesting provider', async () => {
    const store = new MemoryProviderCredentialStore()
    const auth = new AntigravityAuthAdapter(store)
    const validUntil = Date.now() + 3_600_000
    const ref1 = await store.create({
      providerId: 'provider-1',
      refreshToken: 't1',
      accessToken: 'access-1',
      accessExpiresAt: validUntil,
      email: 'user1@example.com',
    })
    const ref2 = await store.create({
      providerId: 'provider-2',
      refreshToken: 't2',
      accessToken: 'access-2',
      accessExpiresAt: validUntil,
      email: 'user2@example.com',
    })
    const getAccessContext = vi.spyOn(auth, 'getAccessContext')
    const adapter = new AntigravityTransportAdapter(auth)

    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}]}\n\n',
            ),
          )
          controller.close()
        },
      }),
      headers: new Headers({ 'content-type': 'text/event-stream' }),
    })

    const request = { messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal } as any
    const events: any[] = []
    for await (const event of adapter.stream(request, { providerId: 'provider-2', model: 'gemini-3.6-flash' })) {
      events.push(event)
    }

    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(getAccessContext).toHaveBeenCalledWith(ref2)
    expect(getAccessContext).not.toHaveBeenCalledWith(ref1)
  })

  it('falls back across every account and reports one line per account when all fail', async () => {
    const store = new MemoryProviderCredentialStore()
    const auth = new AntigravityAuthAdapter(store)
    const validUntil = Date.now() + 3_600_000
    for (const email of ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com']) {
      await store.create({
        providerId: 'provider-1',
        refreshToken: `t-${email}`,
        accessToken: `access-${email}`,
        accessExpiresAt: validUntil,
        email,
      })
    }
    const adapter = new AntigravityTransportAdapter(auth)

    const quota = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted (e.g. check quota).' } })
    const verify = JSON.stringify({
      error: {
        code: 403,
        status: 'PERMISSION_DENIED',
        message: 'Verify your account to continue.',
        details: [{ reason: 'VALIDATION_REQUIRED' }],
      },
    })
    const failing = (status: number, body: string) => ({ ok: false, status, statusText: 'x', text: async () => body })
    let call = 0
    mockFetch.mockImplementation(async () => {
      const account = Math.floor(call++ / 3)
      return account % 2 === 0 ? failing(429, quota) : failing(403, verify)
    })

    const request = { messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal } as any
    const events: any[] = []
    for await (const event of adapter.stream(request, { providerId: 'provider-1', model: 'gemini-3.6-flash' })) {
      events.push(event)
    }

    expect(mockFetch).toHaveBeenCalledTimes(12)
    const error = events.find((event) => event.type === 'error')?.error as string
    expect(error).toContain('All Google Antigravity accounts failed')
    expect(error).toContain('a@example.com: 429 RESOURCE_EXHAUSTED')
    expect(error).toContain('b@example.com: 403 PERMISSION_DENIED VALIDATION_REQUIRED - Verify your account to continue')
    expect(error.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(4)
  })

  it('falls back to the daily endpoint when production answers 429 for the same account', async () => {
    const store = new MemoryProviderCredentialStore()
    const auth = new AntigravityAuthAdapter(store)
    await store.create({
      providerId: 'provider-1',
      refreshToken: 't1',
      accessToken: 'access-1',
      accessExpiresAt: Date.now() + 3_600_000,
      email: 'solo@example.com',
    })
    const adapter = new AntigravityTransportAdapter(auth)

    mockFetch.mockImplementation(async (url: string) => {
      if (url.startsWith('https://daily-cloudcode-pa')) {
        return {
          ok: true,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}}\n\n',
                ),
              )
              controller.close()
            },
          }),
          headers: new Headers({ 'content-type': 'text/event-stream' }),
        }
      }
      return { ok: false, status: 429, statusText: 'x', text: async () => '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}' }
    })

    const request = { messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal } as any
    const events: any[] = []
    for await (const event of adapter.stream(request, { providerId: 'provider-1', model: 'gemini-3.6-flash' })) {
      events.push(event)
    }

    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(events.find((event) => event.type === 'done')?.response.content).toBe('ok')
    expect(String(mockFetch.mock.calls[0]?.[0])).toContain('daily-cloudcode-pa')
  })

  it('refuses to stream when the provider owns no account', async () => {
    const store = new MemoryProviderCredentialStore()
    const auth = new AntigravityAuthAdapter(store)
    await store.create({ providerId: 'provider-1', refreshToken: 't1', email: 'user1@example.com' })
    const adapter = new AntigravityTransportAdapter(auth)

    const request = { messages: [{ role: 'user', content: 'hi' }], signal: new AbortController().signal } as any
    const events: any[] = []
    for await (const event of adapter.stream(request, { providerId: 'provider-2' })) {
      events.push(event)
    }

    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('error')
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
