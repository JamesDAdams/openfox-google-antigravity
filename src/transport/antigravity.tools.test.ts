import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AntigravityTransportAdapter } from './antigravity.js'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const auth = {
  id: 'google-antigravity-auth',
  listAccounts: vi.fn(),
  getAccessContext: vi.fn(),
  getProjectId: vi.fn(),
  updateAccount: vi.fn().mockResolvedValue(undefined),
}

function sse(payload: unknown): unknown {
  return {
    ok: true,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`))
        controller.close()
      },
    }),
    headers: new Headers({ 'content-type': 'text/event-stream' }),
  }
}

async function run(request: Record<string, unknown>) {
  const adapter = new AntigravityTransportAdapter(auth as any)
  const events: any[] = []
  for await (const event of adapter.stream(
    { signal: new AbortController().signal, ...request } as any,
    { providerId: 'p', model: 'gemini-3.7-flash-tiered' } as any,
  )) {
    events.push(event)
  }
  return events
}

describe('tool calling', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    auth.listAccounts.mockResolvedValue([{ credentialRef: 'c1', email: 'a@x.com' }])
    auth.getAccessContext.mockResolvedValue({ accessToken: 't', headers: { Authorization: 'Bearer t' } })
    auth.getProjectId.mockResolvedValue('proj')
  })

  it('turns type arrays into a single type with nullable, which Google accepts', async () => {
    mockFetch.mockResolvedValueOnce(sse({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }))
    await run({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'run_command',
            description: 'x',
            parameters: {
              $schema: 'http://json-schema.org/draft-07/schema#',
              type: 'object',
              properties: { command: { type: 'string' }, cwd: { type: ['string', 'null'] } },
            },
          },
        },
      ],
    })

    const body = JSON.parse((mockFetch.mock.calls[0]?.[1] as RequestInit).body as string)
    const parameters = body.request.tools[0].functionDeclarations[0].parameters
    expect(parameters.$schema).toBeUndefined()
    expect(parameters.properties.cwd).toEqual({ type: 'string', nullable: true })
  })

  it('reports tool_calls as the finish reason when the model calls a function', async () => {
    mockFetch.mockResolvedValueOnce(
      sse({
        candidates: [
          { content: { parts: [{ functionCall: { id: 'call_1', name: 'run_command', args: { command: 'ls' } } }] }, finishReason: 'STOP' },
        ],
      }),
    )
    const events = await run({ messages: [{ role: 'user', content: 'ls' }] })

    const done = events.find((event) => event.type === 'done')
    expect(done?.response.finishReason).toBe('tool_calls')
    expect(done?.response.toolCalls).toEqual([{ id: 'call_1', name: 'run_command', arguments: { command: 'ls' } }])
  })

  it('sends tool results back as user functionResponse parts carrying the function name and id', async () => {
    mockFetch.mockResolvedValueOnce(sse({ candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] }))
    await run({
      messages: [
        { role: 'user', content: 'ls' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'run_command', arguments: { command: 'ls' } }] },
        { role: 'tool', toolCallId: 'call_1', content: 'a.txt' },
      ],
    })

    const { contents } = JSON.parse((mockFetch.mock.calls[0]?.[1] as RequestInit).body as string).request
    expect(contents).toHaveLength(3)
    expect(contents[1]).toEqual({
      role: 'model',
      parts: [{ functionCall: { id: 'call_1', name: 'run_command', args: { command: 'ls' } } }],
    })
    expect(contents[2]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { id: 'call_1', name: 'run_command', response: { content: 'a.txt' } } }],
    })
  })

  it('groups several tool results into one user turn', async () => {
    mockFetch.mockResolvedValueOnce(sse({ candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] }))
    await run({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'a', name: 'read_file', arguments: {} },
            { id: 'b', name: 'run_command', arguments: {} },
          ],
        },
        { role: 'tool', toolCallId: 'a', content: '1' },
        { role: 'tool', toolCallId: 'b', content: '2' },
      ],
    })

    const { contents } = JSON.parse((mockFetch.mock.calls[0]?.[1] as RequestInit).body as string).request
    expect(contents).toHaveLength(3)
    expect(contents[2].parts.map((part: any) => part.functionResponse.name)).toEqual(['read_file', 'run_command'])
  })

  it('keeps the thought signature of a function call and sends it back on the next turn (Gemini 3 rejects it otherwise)', async () => {
    mockFetch.mockResolvedValueOnce(
      sse({
        candidates: [
          {
            content: {
              parts: [{ thoughtSignature: 'SIG-123', functionCall: { id: 'call_sig', name: 'run_command', args: { command: 'ls' } } }],
            },
            finishReason: 'STOP',
          },
        ],
      }),
    )
    await run({ messages: [{ role: 'user', content: 'ls' }] })

    mockFetch.mockResolvedValueOnce(sse({ candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] }))
    await run({
      messages: [
        { role: 'user', content: 'ls' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_sig', name: 'run_command', arguments: { command: 'ls' } }] },
        { role: 'tool', toolCallId: 'call_sig', content: 'a.txt' },
      ],
    })

    const { contents } = JSON.parse((mockFetch.mock.calls[1]?.[1] as RequestInit).body as string).request
    expect(contents[1].parts[0]).toEqual({
      functionCall: { id: 'call_sig', name: 'run_command', args: { command: 'ls' } },
      thoughtSignature: 'SIG-123',
    })
  })

  it('gives every call a distinct id even when Google returns none, so parallel calls are not merged', async () => {
    mockFetch.mockResolvedValueOnce(
      sse({
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: 'read_file', args: { path: 'a' } } },
                { functionCall: { name: 'read_file', args: { path: 'b' } } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      }),
    )
    const events = await run({ messages: [{ role: 'user', content: 'read' }] })

    const calls = events.find((event) => event.type === 'done')?.response.toolCalls
    expect(calls).toHaveLength(2)
    expect(new Set(calls.map((call: any) => call.id)).size).toBe(2)
  })
})
