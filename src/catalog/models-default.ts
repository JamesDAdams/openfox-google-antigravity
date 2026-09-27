import type { ModelConfig } from 'openfox/provider'
import '../quota/contract.js'

export const DEFAULT_ANTIGRAVITY_MODELS: ModelConfig[] = [
  {
    id: 'gemini-3.8-flash-tiered',
    name: 'Gemini 3.8 Flash',
    contextWindow: 1048576,
    supportsVision: true,
    reasoningEfforts: ['low', 'medium', 'high'],
    thinkingLevel: 'high',
    source: 'default',
  },
  {
    id: 'gemini-3.7-flash-tiered',
    name: 'Gemini 3.7 Flash',
    contextWindow: 1048576,
    supportsVision: true,
    reasoningEfforts: ['low', 'medium', 'high'],
    thinkingLevel: 'medium',
    source: 'default',
  },
  {
    id: 'gemini-3.6-flash',
    name: 'Gemini 3.6 Flash',
    contextWindow: 1048576,
    supportsVision: true,
    reasoningEfforts: ['low', 'medium', 'high'],
    thinkingLevel: 'medium',
    source: 'default',
  },
  {
    id: 'gemini-3.1-pro',
    name: 'Gemini 3.1 Pro',
    contextWindow: 1048576,
    supportsVision: true,
    reasoningEfforts: ['low', 'high'],
    thinkingLevel: 'low',
    source: 'default',
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6 (Thinking)',
    contextWindow: 250000,
    supportsVision: true,
    reasoningEfforts: ['low', 'medium', 'high'],
    source: 'default',
  },
  {
    id: 'claude-opus-4-6-thinking',
    name: 'Claude Opus 4.6 (Thinking)',
    contextWindow: 250000,
    supportsVision: true,
    reasoningEfforts: ['low', 'medium', 'high'],
    source: 'default',
  },
  {
    id: 'gpt-oss-120b-medium',
    name: 'GPT-OSS 120B (Medium)',
    contextWindow: 131072,
    supportsVision: false,
    reasoningEfforts: ['low', 'medium', 'high'],
    source: 'default',
  },
]

export function getDefaultModels(): ModelConfig[] {
  return DEFAULT_ANTIGRAVITY_MODELS.map((m) => ({
    ...m,
    ...(m.reasoningEfforts ? { reasoningEfforts: [...m.reasoningEfforts] } : {}),
  }))
}
