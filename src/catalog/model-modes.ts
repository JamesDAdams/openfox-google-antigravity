import type { ModelConfig } from 'openfox/provider'

/**
 * Antigravity exposes reasoning tiers as distinct catalog entries (e.g.
 * `gemini-3.6-flash-high`) instead of a single id carrying a thinking level.
 * The plugin advertises one model per family and resolves the concrete catalog
 * id itself, so no mode merging is required from the host.
 */
export const MODE_API_MODEL_IDS: Record<string, Record<string, string>> = {
  'gemini-3.6-flash': {
    low: 'gemini-3.6-flash-low',
    medium: 'gemini-3.6-flash-medium',
    high: 'gemini-3.6-flash-high',
  },
  'gemini-3.1-pro': {
    low: 'gemini-3.1-pro-low',
    // `gemini-3.1-pro-high` is advertised by fetchAvailableModels but rejected
    // with 400 INVALID_ARGUMENT; `gemini-pro-agent` is the callable entry that
    // backs "Gemini 3.1 Pro (High)".
    high: 'gemini-pro-agent',
  },
}

export type ModeApiModelIds = Record<string, Record<string, string>>

export function buildModeApiModelIds(models: ModelConfig[]): ModeApiModelIds {
  const map: ModeApiModelIds = {}
  for (const [id, levels] of Object.entries(MODE_API_MODEL_IDS)) {
    map[id] = { ...levels }
  }
  for (const model of models) {
    if (!model.modes?.length) continue
    const levels = (map[model.id] ??= {})
    for (const mode of model.modes) {
      levels[mode.level] = mode.apiModelId
    }
  }
  return map
}
