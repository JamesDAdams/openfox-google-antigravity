import type {
  ProviderTransportAdapter,
  ProviderRequestContext,
  ProviderAccessContext,
  ModelConfig,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMStreamEvent,
  ToolCall,
  LLMMessage,
  LLMToolDefinition,
} from 'openfox/provider'
import { AntigravityAuthAdapter } from '../auth/antigravity-auth.js'
import { ANTIGRAVITY_ENDPOINTS, ANTIGRAVITY_DEFAULT_PROJECT_ID } from '../constants.js'
import { getDefaultModels } from '../catalog/models-default.js'

interface AntigravityModelEntry {
  displayName?: string
  quotaInfo?: { remainingFraction?: number; resetTime?: string }
}

function convertMessages(msgs: LLMMessage[]): { contents: unknown[]; systemInstruction?: { parts: Array<{ text: string }> } } {
  const systemMsgs = msgs.filter(m => m.role === 'system')
  const systemInstruction = systemMsgs.length > 0
    ? { parts: systemMsgs.map(m => ({ text: m.content ?? '' })) }
    : undefined

  const contents: unknown[] = []
  for (const m of msgs) {
    if (m.role === 'system') continue

    const role = m.role === 'assistant' ? 'model' : m.role
    const parts: unknown[] = []

    if (m.content) {
      parts.push({ text: m.content })
    }

    if (m.role === 'assistant' && m.toolCalls?.length) {
      for (const tc of m.toolCalls) {
        parts.push({
          functionCall: { name: tc.name, args: tc.arguments },
        })
      }
    }

    if (m.role === 'tool' && m.toolCallId) {
      parts.push({
        functionResponse: {
          name: m.toolCallId,
          response: { content: m.content ?? '' },
        },
      })
    }

    contents.push({ role, parts })
  }

  return { contents, systemInstruction }
}

function cleanJSONSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') {
    return schema
  }

  if (Array.isArray(schema)) {
    return schema.map(cleanJSONSchema)
  }

  const cleaned: any = {}
  for (const [key, val] of Object.entries(schema)) {
    // Skip unsupported JSON Schema keywords for Gemini
    if (
      key === '$schema' ||
      key === '$id' ||
      key === '$vocabulary' ||
      key === '$anchor' ||
      key === 'dependentRequired' ||
      key === 'dependentSchemas' ||
      key === 'unevaluatedProperties' ||
      key === 'unevaluatedItems' ||
      key === 'patternProperties'
    ) {
      continue
    }

    if (key === 'const') {
      cleaned.enum = [val]
      continue
    }

    cleaned[key] = cleanJSONSchema(val)
  }

  return cleaned
}

function buildTools(tools: LLMToolDefinition[]): unknown[] {
  return [{
    functionDeclarations: tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      parameters: cleanJSONSchema(t.function.parameters),
    })),
  }]
}

function getThinkingBudget(effort: string): number {
  switch (effort) {
    case 'low': return 8192
    case 'medium': return 16384
    case 'high': return 32768
    default: return 16384
  }
}

function parseFinishReason(reason: string | undefined | null): LLMCompletionResponse['finishReason'] {
  switch (reason) {
    case 'STOP': return 'stop'
    case 'MAX_TOKENS': return 'length'
    case 'SAFETY':
    case 'RECITATION': return 'content_filter'
    case 'TOOL_CALLS':
    case 'FUNCTION_CALL': return 'tool_calls'
    default: return 'stop'
  }
}

export class AntigravityTransportAdapter implements ProviderTransportAdapter {
  readonly id = 'google-antigravity-transport'

  constructor(private readonly auth: AntigravityAuthAdapter) {}

  async listModels(context: ProviderRequestContext): Promise<ModelConfig[]> {
    if (!context.credentialRef) return getDefaultModels()

    try {
      const access = await this.auth.getAccessContext(context.credentialRef)
      const projectId = await this.auth.getProjectId(context.credentialRef)
      const apiModels = await this.fetchAvailableModels(access, projectId)
      if (apiModels.length > 0) return apiModels
    } catch { /* fall through */ }

    return getDefaultModels()
  }

  private async fetchAvailableModels(access: ProviderAccessContext, projectId?: string): Promise<ModelConfig[]> {
    for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
      try {
        const res = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
          method: 'POST',
          headers: {
            ...access.headers,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ project: projectId ?? ANTIGRAVITY_DEFAULT_PROJECT_ID }),
          signal: AbortSignal.timeout(10000),
        })

        if (!res.ok) continue

        const data = await res.json() as { models?: Record<string, AntigravityModelEntry> }
        if (!data.models) continue

        const rawModels = Object.entries(data.models).filter(([id, entry]) => {
          if (entry.displayName?.toLowerCase().startsWith('chat_')) return false
          if (entry.displayName?.toLowerCase().includes('rev19')) return false
          return true
        })

        // Count occurrences of each displayName to identify duplicates
        const nameCounts = new Map<string, number>()
        for (const [id, entry] of rawModels) {
          const name = entry.displayName ?? id
          nameCounts.set(name, (nameCounts.get(name) || 0) + 1)
        }

        const models: ModelConfig[] = []
        for (const [id, entry] of rawModels) {
          const baseName = entry.displayName ?? id
          const isDuplicate = (nameCounts.get(baseName) || 0) > 1
          const name = isDuplicate ? `${baseName} (${id})` : baseName

          models.push({
            id,
            name,
            contextWindow: 200000,
            source: 'backend',
          })
        }
        if (models.length > 0) return models
      } catch { /* try next */ }
    }

    return []
  }

  async complete(request: LLMCompletionRequest, context: ProviderRequestContext): Promise<LLMCompletionResponse> {
    let result: LLMCompletionResponse | undefined
    for await (const event of this.stream(request, context)) {
      if (event.type === 'done') result = event.response
      if (event.type === 'error') throw new Error(event.error)
    }
    if (!result) throw new Error('Antigravity response completed without a final response')
    return result
  }

  async *stream(request: LLMCompletionRequest, context: ProviderRequestContext): AsyncIterable<LLMStreamEvent> {
    if (!context.credentialRef) {
      yield { type: 'error', error: 'Google Antigravity account is not connected' }
      return
    }

    try {
      const access = await this.auth.getAccessContext(context.credentialRef)
      const model = context.model || 'gemini-3-flash'
      yield* this.streamGenerateContent(request, access, model)
    } catch (error: any) {
      yield { type: 'error', error: error.message || String(error) }
    }
  }

  private async *streamGenerateContent(
    request: LLMCompletionRequest,
    access: ProviderAccessContext,
    model: string,
  ): AsyncIterable<LLMStreamEvent> {
    const { contents, systemInstruction } = convertMessages(request.messages)

    const generationConfig: Record<string, unknown> = {}
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature
    if (request.maxTokens !== undefined) generationConfig.maxOutputTokens = request.maxTokens
    if (request.reasoningEffort) generationConfig.thinkingConfig = { thinkingBudget: getThinkingBudget(request.reasoningEffort) }

    const innerRequest: Record<string, unknown> = {
      contents,
      generationConfig,
      ...(request.tools?.length ? { tools: buildTools(request.tools) } : {}),
      ...(systemInstruction ? { systemInstruction } : {}),
    }

    const tc = request.toolChoice
    if (tc) {
      if (tc === 'auto') {
        innerRequest.toolConfig = {
          functionCallingConfig: { mode: 'AUTO' }
        }
      } else if (tc === 'required') {
        innerRequest.toolConfig = {
          functionCallingConfig: { mode: 'ANY' }
        }
      } else if (typeof tc === 'object' && tc.function?.name) {
        innerRequest.toolConfig = {
          functionCallingConfig: {
            mode: 'ANY',
            allowedFunctionNames: [tc.function.name]
          }
        }
      }
    }

    const body = { model, request: innerRequest }

    let lastError: Error | undefined
    for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
      try {
        const url = `${endpoint}/v1internal:streamGenerateContent?alt=sse`
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...access.headers,
          },
          body: JSON.stringify(body),
          signal: request.signal,
        })

        if (!res.ok) {
          const errText = await res.text().catch(() => res.statusText)
          if (res.status >= 500 || res.status === 429 || res.status === 400) {
            lastError = new Error(`Antigravity API error (${res.status}): ${errText}`)
            continue
          }
          yield { type: 'error', error: `Antigravity API error (${res.status}): ${errText}` }
          return
        }

        if (!res.body) {
          yield { type: 'error', error: 'Response body is empty' }
          return
        }

        yield* this.parseSSE(res.body)
        return
      } catch (error: any) {
        lastError = error
      }
    }

    if (lastError) {
      yield { type: 'error', error: lastError.message }
    }
  }

  private async *parseSSE(body: ReadableStream<Uint8Array>): AsyncIterable<LLMStreamEvent> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let fullContent = ''
    let fullThinking = ''
    const toolCalls = new Map<string, { name: string; args: string }>()
    let responseId = crypto.randomUUID()
    let finishReason: LLMCompletionResponse['finishReason'] = 'stop'
    let usage: LLMCompletionResponse['usage'] = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

    const parseLine = (line: string) => {
      const cleaned = line.trim()
      if (!cleaned || cleaned === 'data: [DONE]' || !cleaned.startsWith('data: ')) return
      return this.parseEventData(cleaned.slice(6))
    }

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          const parsed = parseLine(buffer)
          if (parsed) {
            if (parsed.thinking) { fullThinking += parsed.thinking; yield { type: 'thinking_delta', content: parsed.thinking } }
            if (parsed.text) { fullContent += parsed.text; yield { type: 'text_delta', content: parsed.text } }
            if (parsed.finishReason) finishReason = parsed.finishReason
            if (parsed.usage) usage = parsed.usage
            if (parsed.toolCalls) {
              for (const tc of parsed.toolCalls) toolCalls.set(crypto.randomUUID(), { name: tc.name, args: tc.args })
            }
          }
          break
        }

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const parsed = parseLine(line)
          if (!parsed) continue
          if (parsed.thinking) { fullThinking += parsed.thinking; yield { type: 'thinking_delta', content: parsed.thinking } }
          if (parsed.text) { fullContent += parsed.text; yield { type: 'text_delta', content: parsed.text } }
          if (parsed.finishReason) finishReason = parsed.finishReason
          if (parsed.usage) usage = parsed.usage
          if (parsed.toolCalls) {
            for (const tc of parsed.toolCalls) toolCalls.set(crypto.randomUUID(), { name: tc.name, args: tc.args })
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    const parsedToolCalls: ToolCall[] = []
    for (const [id, tc] of toolCalls) {
      try {
        parsedToolCalls.push({ id, name: tc.name, arguments: JSON.parse(tc.args) as Record<string, unknown> })
      } catch {
        parsedToolCalls.push({ id, name: tc.name, arguments: {}, parseError: 'Parse error', rawArguments: tc.args })
      }
    }

    yield {
      type: 'done',
      response: {
        id: responseId,
        content: fullContent,
        ...(fullThinking && { thinkingContent: fullThinking }),
        ...(parsedToolCalls.length > 0 && { toolCalls: parsedToolCalls }),
        finishReason,
        usage,
      },
    }
  }

  private parseEventData(dataStr: string): {
    text?: string
    thinking?: string
    finishReason?: LLMCompletionResponse['finishReason']
    usage?: LLMCompletionResponse['usage']
    toolCalls?: Array<{ name: string; args: string }>
  } | null {
    let parsed: any
    try {
      parsed = JSON.parse(dataStr)
    } catch {
      return null
    }

    const response = parsed.response ?? parsed
    const candidates = response.candidates as Array<{
      content?: { parts?: Array<{ text?: string; thought?: string; thinking?: string }>; role?: string }
      finishReason?: string
      finish_reason?: string
    }> | undefined
    if (!candidates?.length) return null

    const candidate = candidates[0]
    const parts = candidate.content?.parts

    let text = ''
    let thinking = ''
    const toolCalls: Array<{ name: string; args: string }> = []
    if (parts?.length) {
      for (const part of parts) {
        if (part.thought) thinking += part.thought
        else if (part.thinking) thinking += part.thinking
        if (part.text) text += part.text
        const fc = (part as any).functionCall as { name?: string; args?: unknown } | undefined
        if (fc?.name) {
          toolCalls.push({ name: fc.name, args: typeof fc.args === 'string' ? fc.args : JSON.stringify(fc.args ?? {}) })
        }
      }
    }

    const reason = candidate.finishReason ?? candidate.finish_reason
    if (!text && !thinking && !reason && !toolCalls.length) return null

    const data: {
      text?: string
      thinking?: string
      finishReason?: LLMCompletionResponse['finishReason']
      usage?: LLMCompletionResponse['usage']
      toolCalls?: Array<{ name: string; args: string }>
    } = {}
    if (text) data.text = text
    if (thinking) data.thinking = thinking
    if (reason) data.finishReason = parseFinishReason(reason)
    if (toolCalls.length > 0) data.toolCalls = toolCalls

    const um = response.usageMetadata as { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } | undefined
    if (um) {
      data.usage = {
        promptTokens: um.promptTokenCount ?? 0,
        completionTokens: um.candidatesTokenCount ?? 0,
        totalTokens: um.totalTokenCount ?? 0,
      }
    }

    return data
  }
}
