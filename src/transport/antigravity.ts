import { proxyFetch } from '../net.js'
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
import { ANTIGRAVITY_ENDPOINTS, ANTIGRAVITY_DEFAULT_PROJECT_ID, getAntigravityHeaders } from '../constants.js'
import { getDefaultModels } from '../catalog/models-default.js'
import { buildModeApiModelIds, type ModeApiModelIds } from '../catalog/model-modes.js'
import { RoutingEngine, type RoutingStrategy, type RoutableAccount } from '../routing/routing-engine.js'

interface AntigravityModelEntry {
  displayName?: string
  /** Context window (max input tokens) */
  maxTokens?: number
  maxOutputTokens?: number
  supportsImages?: boolean
  supportedMimeTypes?: Record<string, boolean>
  quotaInfo?: { remainingFraction?: number; resetTime?: string }
}

export interface InternalRoutableAntigravityAccount extends RoutableAccount {
  credentialRef: string
  email?: string
  projectId?: string
}

const LEGACY_FALLBACK_CONTEXT_WINDOW = 200000

function entryContextWindow(entry: AntigravityModelEntry): number {
  return typeof entry.maxTokens === 'number' && entry.maxTokens > 0
    ? entry.maxTokens
    : LEGACY_FALLBACK_CONTEXT_WINDOW
}

function stripModeVariants(models: ModelConfig[]): ModelConfig[] {
  return models.map(({ modes: _modes, ...model }) => model)
}

function entrySupportsVision(entry: AntigravityModelEntry): boolean {
  if (typeof entry.supportsImages === 'boolean') return entry.supportsImages
  if (entry.supportedMimeTypes) {
    return Object.keys(entry.supportedMimeTypes).some((mime) => mime.startsWith('image/'))
  }
  return false
}

const MAX_SIGNATURES = 2000
const thoughtSignatures = new Map<string, string>()

function rememberSignature(callId: string, signature: string): void {
  if (thoughtSignatures.size >= MAX_SIGNATURES) {
    const oldest = thoughtSignatures.keys().next().value
    if (oldest !== undefined) thoughtSignatures.delete(oldest)
  }
  thoughtSignatures.set(callId, signature)
}

export function getThoughtSignature(callId: string): string | undefined {
  return thoughtSignatures.get(callId)
}

function convertMessages(msgs: LLMMessage[]): { contents: unknown[]; systemInstruction?: { parts: Array<{ text: string }> } } {
  const systemMsgs = msgs.filter((m) => m.role === 'system')
  const systemInstruction =
    systemMsgs.length > 0 ? { parts: systemMsgs.map((m) => ({ text: m.content ?? '' })) } : undefined

  const toolNameById = new Map<string, string>()
  for (const m of msgs) {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      for (const tc of m.toolCalls) toolNameById.set(tc.id, tc.name)
    }
  }

  const contents: unknown[] = []
  for (const m of msgs) {
    if (m.role === 'system') continue

    const isTool = m.role === 'tool'
    const role = m.role === 'assistant' ? 'model' : isTool ? 'user' : m.role
    const parts: unknown[] = []

    if (m.content && !isTool) {
      parts.push({ text: m.content })
    }

    if (m.role === 'assistant' && m.toolCalls?.length) {
      for (const tc of m.toolCalls) {
        const signature = thoughtSignatures.get(tc.id)
        parts.push({
          functionCall: { id: tc.id, name: tc.name, args: tc.arguments },
          ...(signature ? { thoughtSignature: signature } : {}),
        })
      }
    }

    if (isTool && m.toolCallId) {
      parts.push({
        functionResponse: {
          id: m.toolCallId,
          name: toolNameById.get(m.toolCallId) ?? m.toolCallId,
          response: { content: m.content ?? '' },
        },
      })
    }

    if (parts.length === 0) continue

    const last = contents[contents.length - 1] as { role: string; parts: unknown[] } | undefined
    if (isTool && last && last.role === 'user' && last.parts.every((p) => (p as any).functionResponse)) {
      last.parts.push(...parts)
      continue
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

    if (key === 'type' && Array.isArray(val)) {
      const types = val.filter((entry): entry is string => typeof entry === 'string')
      const concrete = types.filter((entry) => entry !== 'null')
      cleaned.type = concrete[0] ?? types[0] ?? 'string'
      if (types.includes('null')) cleaned.nullable = true
      continue
    }

    cleaned[key] = cleanJSONSchema(val)
  }

  return cleaned
}

function buildTools(tools: LLMToolDefinition[]): unknown[] {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: cleanJSONSchema(t.function.parameters),
      })),
    },
  ]
}

function getThinkingBudget(effort: string): number {
  switch (effort) {
    case 'low':
      return 8192
    case 'medium':
      return 16384
    case 'high':
      return 32768
    default:
      return 16384
  }
}

export function pickEndpointError(errors: Array<{ status: number; message: string }>): string {
  const meaningful = errors.find((entry) => !entry.message.includes('SUBSCRIPTION_REQUIRED'))
  return (meaningful ?? errors[errors.length - 1])?.message ?? 'Antigravity request failed'
}

export function summarizeApiError(raw: string): string {
  const jsonStart = raw.indexOf('{')
  if (jsonStart === -1) return raw.slice(0, 200)
  try {
    const parsed = JSON.parse(raw.slice(jsonStart)) as {
      error?: { code?: number; status?: string; message?: string; details?: Array<{ reason?: string }> }
    }
    const err = parsed.error
    if (!err) return raw.slice(0, 200)
    const reason = err.details?.find((detail) => detail.reason)?.reason
    const head = [err.code, err.status, reason].filter(Boolean).join(' ')
    const message = (err.message ?? '').split('. ')[0]
    return `${head}${message ? ` - ${message}` : ''}`
  } catch {
    return raw.slice(0, 200)
  }
}

function parseFinishReason(reason: string | undefined | null): LLMCompletionResponse['finishReason'] {
  switch (reason) {
    case 'STOP':
      return 'stop'
    case 'MAX_TOKENS':
      return 'length'
    case 'SAFETY':
    case 'RECITATION':
      return 'content_filter'
    case 'TOOL_CALLS':
    case 'FUNCTION_CALL':
      return 'tool_calls'
    default:
      return 'stop'
  }
}

export class AntigravityTransportAdapter implements ProviderTransportAdapter {
  readonly id = 'google-antigravity-transport'
  private readonly routingEngine: RoutingEngine<InternalRoutableAntigravityAccount>

  constructor(
    private readonly auth: AntigravityAuthAdapter,
    private readonly getSettings?: () => Record<string, unknown>,
    private readonly logger?: {
      warn: (msg: string, ctx?: Record<string, unknown>) => void
      info?: (msg: string, ctx?: Record<string, unknown>) => void
      error?: (msg: string, ctx?: Record<string, unknown>) => void
    },
  ) {
    this.routingEngine = new RoutingEngine<InternalRoutableAntigravityAccount>({
      strategy: 'fill-first',
      stickyLimit: 3,
    })
  }

  private updateRoutingSettings(): void {
    const settings = this.getSettings?.()
    if (settings) {
      const strategy = (settings['routingStrategy'] as RoutingStrategy) || 'fill-first'
      this.routingEngine.setStrategy(strategy)
      const stickyLimit = typeof settings['roundRobinStickyLimit'] === 'number' ? settings['roundRobinStickyLimit'] : 3
      this.routingEngine.setStickyLimit(stickyLimit)
    }
  }

  /**
   * Accounts this request may route to: only those owned by the provider that
   * owns the request. Never borrow another provider's accounts.
   */
  private async getRoutableAccounts(
    providerId?: string,
    contextCredentialRef?: string,
  ): Promise<InternalRoutableAntigravityAccount[]> {
    const allAccounts =
      typeof this.auth?.listAccounts === 'function' ? await this.auth.listAccounts(providerId) : []
    if (allAccounts.length === 0) {
      if (contextCredentialRef) {
        return [
          {
            id: contextCredentialRef,
            credentialRef: contextCredentialRef,
          },
        ]
      }
      return []
    }

    return allAccounts.map((acc, index) => ({
      id: acc.credentialRef,
      credentialRef: acc.credentialRef,
      label: acc.email,
      email: acc.email,
      projectId: acc.projectId,
      priority: acc.priority ?? index,
      cost: acc.cost,
      disabled: acc.disabled,
      lastUsedAt: acc.lastUsedAt,
    }))
  }

  private getConfiguredModels(): ModelConfig[] {
    const settings = this.getSettings?.()
    const rawConfig = settings?.['modelsConfig']
    if (typeof rawConfig === 'string' && rawConfig.trim()) {
      try {
        const parsed = JSON.parse(rawConfig)
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map((item: any) => ({
            id: String(item.id),
            name: item.name !== undefined ? String(item.name) : undefined,
            contextWindow: typeof item.contextWindow === 'number' ? item.contextWindow : 1048576,
            supportsVision: item.supportsVision !== undefined ? Boolean(item.supportsVision) : undefined,
            reasoningEfforts: Array.isArray(item.reasoningEfforts) ? item.reasoningEfforts.map(String) : undefined,
            thinkingLevel: item.thinkingLevel !== undefined ? String(item.thinkingLevel) : undefined,
            modes: Array.isArray(item.modes)
              ? item.modes.map((mode: any) => ({
                  level: String(mode.level),
                  apiModelId: String(mode.apiModelId),
                  name: mode.name !== undefined ? String(mode.name) : undefined,
                }))
              : undefined,
            source: 'default' as const,
          }))
        }
      } catch (err: any) {
        this.logger?.warn('Invalid modelsConfig JSON in Antigravity settings, falling back to default models', {
          error: err?.message || String(err),
        })
      }
    }
    return getDefaultModels()
  }

  async listModels(context: ProviderRequestContext): Promise<ModelConfig[]> {
    const configuredModels = this.getConfiguredModels()
    const routable = await this.getRoutableAccounts(context.providerId, context.credentialRef)
    const activeAccount = routable.find((a) => !a.disabled) ?? routable[0]
    if (!activeAccount) return stripModeVariants(configuredModels)

    try {
      const access = await this.auth.getAccessContext(activeAccount.credentialRef)
      const projectId = activeAccount.projectId || (await this.auth.getProjectId(activeAccount.credentialRef))
      const apiMap = await this.fetchAvailableModelsMap(access, projectId)
      if (apiMap && Object.keys(apiMap).length > 0) {
        const modeApiModelIds = buildModeApiModelIds(configuredModels)
        return configuredModels.map((model) => {
          const { modes: _modes, ...rest } = model
          const entry = [
            apiMap[model.id],
            ...Object.values(modeApiModelIds[model.id] ?? {}).map((id) => apiMap[id]),
          ].find((candidate): candidate is AntigravityModelEntry => Boolean(candidate))

          return {
            ...rest,
            contextWindow: entry ? entryContextWindow(entry) : model.contextWindow,
            ...(entry
              ? { supportsVision: entrySupportsVision(entry) }
              : model.supportsVision !== undefined
                ? { supportsVision: model.supportsVision }
                : {}),
            source: 'backend' as const,
          }
        })
      }
    } catch {
      /* fall through */
    }

    return stripModeVariants(configuredModels)
  }

  private getModeApiModelIds(): ModeApiModelIds {
    return buildModeApiModelIds(this.getConfiguredModels())
  }

  private resolveRequestModelId(
    model: string,
    effort: string | undefined,
  ): { model: string; effortEncoded: boolean } {
    const levels = this.getModeApiModelIds()[model]
    if (!levels) return { model, effortEncoded: false }

    const configured = this.getConfiguredModels().find((m) => m.id === model)
    const requested = effort ? levels[effort.toLowerCase()] : undefined
    const fallback = configured?.thinkingLevel ? levels[configured.thinkingLevel.toLowerCase()] : undefined
    const resolved = requested ?? fallback ?? Object.values(levels)[0]
    if (!resolved) return { model, effortEncoded: false }

    return { model: resolved, effortEncoded: true }
  }

  private async fetchAvailableModelsMap(
    access: ProviderAccessContext,
    projectId?: string,
  ): Promise<Record<string, AntigravityModelEntry> | null> {
    const antigravityHeaders = getAntigravityHeaders()

    for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
      try {
        const res = await proxyFetch(`${endpoint}/v1internal:fetchAvailableModels`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: access.headers?.Authorization ?? access.accessToken ? `Bearer ${access.accessToken}` : '',
            'User-Agent': antigravityHeaders['User-Agent'],
          },
          body: JSON.stringify({ project: projectId ?? ANTIGRAVITY_DEFAULT_PROJECT_ID }),
          signal: AbortSignal.timeout(10000),
        })

        if (!res.ok) continue

        const data = (await res.json()) as { models?: Record<string, AntigravityModelEntry> }
        if (data.models) return data.models
      } catch {
        /* try next */
      }
    }

    return null
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
    this.updateRoutingSettings()
    const accounts = await this.getRoutableAccounts(context.providerId, context.credentialRef)
    if (accounts.length === 0) {
      yield { type: 'error', error: 'Google Antigravity account is not connected' }
      return
    }

    const maxAttempts = accounts.length
    let attempts = 0
    let lastError: string | undefined
    const accountErrors: string[] = []
    const triedAccountIds = new Set<string>()

    while (attempts < maxAttempts) {
      const untriedAccounts = accounts.filter((a) => !triedAccountIds.has(a.id))
      const selected = this.routingEngine.selectAccount(untriedAccounts)
      if (!selected) {
        break
      }

      triedAccountIds.add(selected.id)
      attempts++

      try {
        this.routingEngine.recordUsage(selected)
        const access = await this.auth.getAccessContext(selected.credentialRef)
        const projectId = selected.projectId || (await this.auth.getProjectId(selected.credentialRef))
        const model = context.model || 'gemini-3-flash'

        let hadData = false
        let accountError: string | null = null

        for await (const event of this.streamGenerateContent(request, access, model, projectId)) {
          if (event.type === 'error') {
            accountError = event.error
            break
          } else {
            hadData = true
            yield event
          }
        }

        if (accountError) {
          this.routingEngine.recordFailure(selected)
          this.logger?.warn?.(`Antigravity request failed for account ${selected.email || selected.id}: ${accountError}`)
          lastError = accountError
          accountErrors.push(`${selected.email || selected.id}: ${summarizeApiError(accountError)}`)

          let errStatus: 'quota_exceeded' | 'verification_required' | 'expired' | 'error' = 'error'
          if (accountError.includes('429') || accountError.includes('RESOURCE_EXHAUSTED')) {
            errStatus = 'quota_exceeded'
          } else if (accountError.includes('403') || accountError.includes('PERMISSION_DENIED') || accountError.includes('VALIDATION_REQUIRED')) {
            errStatus = 'verification_required'
          } else if (accountError.includes('401') || accountError.includes('UNAUTHENTICATED')) {
            errStatus = 'expired'
          }
          if (typeof this.auth.updateAccount === 'function') {
            void this.auth.updateAccount(selected.credentialRef, {
              lastErrorStatus: errStatus,
              lastErrorMessage: accountError,
            } as any).catch(() => {})
          }

          if (hadData) {
            // Once tokens started streaming, we cannot silently restart the stream without duplicate tokens
            yield { type: 'error', error: accountError }
            return
          }
          // Fallback to next account
          continue
        }

        this.routingEngine.recordSuccess(selected)
        if (typeof this.auth.updateAccount === 'function') {
          void this.auth.updateAccount(selected.credentialRef, {
            lastErrorStatus: 'connected',
            lastErrorMessage: undefined,
          } as any).catch(() => {})
        }
        return
      } catch (error: any) {
        const errorMsg = error.message || String(error)
        this.routingEngine.recordFailure(selected)
        this.logger?.warn?.(`Antigravity stream error for account ${selected.email || selected.id}: ${errorMsg}`)
        lastError = errorMsg
        accountErrors.push(`${selected.email || selected.id}: ${summarizeApiError(errorMsg)}`)
        let errStatus: 'quota_exceeded' | 'verification_required' | 'expired' | 'error' = 'error'
        if (errorMsg.includes('429') || errorMsg.includes('RESOURCE_EXHAUSTED')) {
          errStatus = 'quota_exceeded'
        } else if (errorMsg.includes('403') || errorMsg.includes('PERMISSION_DENIED') || errorMsg.includes('VALIDATION_REQUIRED')) {
          errStatus = 'verification_required'
        } else if (errorMsg.includes('401') || errorMsg.includes('UNAUTHENTICATED')) {
          errStatus = 'expired'
        }
        if (typeof this.auth.updateAccount === 'function') {
          void this.auth.updateAccount(selected.credentialRef, {
            lastErrorStatus: errStatus,
            lastErrorMessage: errorMsg,
          } as any).catch(() => {})
        }
        // Try next account if possible
      }
    }

    const final =
      accountErrors.length > 1
        ? `All Google Antigravity accounts failed:\n${accountErrors.map((line) => `- ${line}`).join('\n')}`
        : lastError || 'All Google Antigravity accounts are unavailable or failed.'
    yield { type: 'error', error: final }
  }

  private async *streamGenerateContent(
    request: LLMCompletionRequest,
    access: ProviderAccessContext,
    model: string,
    accountProjectId?: string,
  ): AsyncIterable<LLMStreamEvent> {
    const { contents, systemInstruction } = convertMessages(request.messages)
    const { model: requestModel, effortEncoded } = this.resolveRequestModelId(model, request.reasoningEffort)

    const generationConfig: Record<string, unknown> = {}
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature
    if (request.maxTokens !== undefined) generationConfig.maxOutputTokens = request.maxTokens
    if (request.reasoningEffort && !effortEncoded) {
      const lowerModel = model.toLowerCase()
      if (lowerModel.includes('gemini-3')) {
        generationConfig.thinkingConfig = {
          includeThoughts: true,
          thinkingLevel: request.reasoningEffort,
        }
      } else if (lowerModel.includes('claude')) {
        const budget = getThinkingBudget(request.reasoningEffort)
        generationConfig.thinkingConfig = {
          include_thoughts: true,
          thinking_budget: budget,
        }
        const current = typeof generationConfig.maxOutputTokens === 'number' ? generationConfig.maxOutputTokens : 0
        if (current <= budget) generationConfig.maxOutputTokens = budget + 8192
      } else {
        generationConfig.thinkingConfig = {
          thinkingBudget: getThinkingBudget(request.reasoningEffort),
        }
      }
    }

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
          functionCallingConfig: { mode: 'AUTO' },
        }
      } else if (tc === 'required') {
        innerRequest.toolConfig = {
          functionCallingConfig: { mode: 'ANY' },
        }
      } else if (typeof tc === 'object' && tc.function?.name) {
        innerRequest.toolConfig = {
          functionCallingConfig: {
            mode: 'ANY',
            allowedFunctionNames: [tc.function.name],
          },
        }
      }
    }

    const body = {
      project: accountProjectId ?? ANTIGRAVITY_DEFAULT_PROJECT_ID,
      model: requestModel,
      request: innerRequest,
      requestType: 'agent',
      userAgent: 'antigravity',
      requestId: `agent-${crypto.randomUUID()}`,
    }

    const antigravityHeaders = getAntigravityHeaders()

    let lastError: Error | undefined
    const endpointErrors: Array<{ status: number; message: string }> = []
    for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
      try {
        const url = `${endpoint}/v1internal:streamGenerateContent?alt=sse`
        const res = await proxyFetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: access.headers?.Authorization ?? access.accessToken ? `Bearer ${access.accessToken}` : '',
            'User-Agent': antigravityHeaders['User-Agent'],
          },
          body: JSON.stringify(body),
          signal: request.signal,
        })

        if (!res.ok) {
          const errText = await res.text().catch(() => res.statusText)
          const message = `Antigravity API error (${res.status}): ${errText}`
          const retryable = res.status >= 500 || res.status === 429 || res.status === 404 || res.status === 403
          if (retryable && endpoint !== ANTIGRAVITY_ENDPOINTS[ANTIGRAVITY_ENDPOINTS.length - 1]) {
            endpointErrors.push({ status: res.status, message })
            continue
          }
          endpointErrors.push({ status: res.status, message })
          yield { type: 'error', error: pickEndpointError(endpointErrors) }
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
    const toolCalls = new Map<string, { name: string; args: string; signature?: string }>()
    let responseId = crypto.randomUUID()
    let finishReason: LLMCompletionResponse['finishReason'] = 'stop'
    let usage: LLMCompletionResponse['usage'] = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

    const parseLine = (line: string) => {
      const cleaned = line.trim()
      if (!cleaned || cleaned === 'data: [DONE]' || !cleaned.startsWith('data: ')) return
      return this.parseEventData(cleaned.slice(6))
    }

    const toolCallIndices = new Map<string, number>()
    const emitToolCall = (tc: { id?: string; name: string; args: string; signature?: string }): LLMStreamEvent => {
      const key = tc.id || `${tc.name}_${toolCalls.size}`
      const isNew = !toolCalls.has(key)
      let index = toolCallIndices.get(key)
      if (index === undefined) {
        index = toolCallIndices.size
        toolCallIndices.set(key, index)
      }
      toolCalls.set(key, { name: tc.name, args: tc.args, ...(tc.signature ? { signature: tc.signature } : {}) })
      return {
        type: 'tool_call_delta',
        index,
        ...(isNew ? { id: key, name: tc.name } : {}),
        arguments: tc.args,
      }
    }

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          const parsed = parseLine(buffer)
          if (parsed) {
            if (parsed.error) {
              yield { type: 'error', error: parsed.error }
              return
            }
            if (parsed.thinking) {
              fullThinking += parsed.thinking
              yield { type: 'thinking_delta', content: parsed.thinking }
            }
            if (parsed.text) {
              fullContent += parsed.text
              yield { type: 'text_delta', content: parsed.text }
            }
            if (parsed.finishReason) finishReason = parsed.finishReason
            if (parsed.usage) usage = parsed.usage
            if (parsed.toolCalls) {
              for (const tc of parsed.toolCalls) {
                yield emitToolCall(tc)
              }
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
          if (parsed.error) {
            yield { type: 'error', error: parsed.error }
            return
          }
          if (parsed.thinking) {
            fullThinking += parsed.thinking
            yield { type: 'thinking_delta', content: parsed.thinking }
          }
          if (parsed.text) {
            fullContent += parsed.text
            yield { type: 'text_delta', content: parsed.text }
          }
          if (parsed.finishReason) finishReason = parsed.finishReason
          if (parsed.usage) usage = parsed.usage
          if (parsed.toolCalls) {
            for (const tc of parsed.toolCalls) {
              yield emitToolCall(tc)
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    const parsedToolCalls: ToolCall[] = []
    for (const [id, tc] of toolCalls) {
      if (tc.signature) rememberSignature(id, tc.signature)
      try {
        parsedToolCalls.push({ id, name: tc.name, arguments: JSON.parse(tc.args) as Record<string, unknown> })
      } catch {
        parsedToolCalls.push({ id, name: tc.name, arguments: {}, parseError: 'Parse error', rawArguments: tc.args })
      }
    }
    if (parsedToolCalls.length > 0 && finishReason === 'stop') finishReason = 'tool_calls'

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
    toolCalls?: Array<{ id?: string; name: string; args: string; signature?: string }>
    error?: string
  } | null {
    let parsed: any
    try {
      parsed = JSON.parse(dataStr)
    } catch {
      return null
    }

    const response = parsed.response ?? parsed
    const candidates = response.candidates as
      | Array<{
          content?: { parts?: Array<{ text?: string; thought?: string; thinking?: string }>; role?: string }
          finishReason?: string
          finish_reason?: string
        }>
      | undefined
    if (!candidates?.length) {
      if (parsed.error) {
        const msg = typeof parsed.error === 'object' ? parsed.error.message || JSON.stringify(parsed.error) : String(parsed.error)
        return { error: msg }
      }
      return null
    }

    const candidate = candidates[0]
    const parts = candidate?.content?.parts

    let text = ''
    let thinking = ''
    const toolCalls: Array<{ id?: string; name: string; args: string; signature?: string }> = []
    if (parts?.length) {
      for (const part of parts) {
        if (part.thought) thinking += part.thought
        else if (part.thinking) thinking += part.thinking
        if (part.text) text += part.text
        const fc = (part as any).functionCall as { id?: string; name?: string; args?: unknown } | undefined
        if (fc?.name) {
          const signature = (part as any).thoughtSignature ?? (part as any).thought_signature
          toolCalls.push({
            id: fc.id,
            name: fc.name,
            args: typeof fc.args === 'string' ? fc.args : JSON.stringify(fc.args ?? {}),
            ...(typeof signature === 'string' ? { signature } : {}),
          })
        }
      }
    }

    const reason = candidate?.finishReason ?? candidate?.finish_reason
    if (!text && !thinking && !reason && !toolCalls.length) return null

    const data: {
      text?: string
      thinking?: string
      finishReason?: LLMCompletionResponse['finishReason']
      usage?: LLMCompletionResponse['usage']
      toolCalls?: Array<{ id?: string; name: string; args: string; signature?: string }>
    } = {}
    if (text) data.text = text
    if (thinking) data.thinking = thinking
    if (reason) data.finishReason = parseFinishReason(reason)
    if (toolCalls.length > 0) data.toolCalls = toolCalls

    const um = response.usageMetadata as
      | { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
      | undefined
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
