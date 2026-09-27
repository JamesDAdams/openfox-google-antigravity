import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { RoutingStrategy } from './routing/routing-engine.js'

export interface AntigravityPluginSettings {
  routingStrategy: RoutingStrategy
  roundRobinStickyLimit: number
  modelsConfig?: string
}

export const DEFAULT_SETTINGS: AntigravityPluginSettings = {
  routingStrategy: 'fill-first',
  roundRobinStickyLimit: 3,
}

export class PluginSettingsStore {
  private cached: AntigravityPluginSettings | null = null

  constructor(private readonly settingsPath: string) {}

  async load(): Promise<AntigravityPluginSettings> {
    if (this.cached) return this.cached
    try {
      const raw = await readFile(this.settingsPath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AntigravityPluginSettings>
      this.cached = {
        routingStrategy: parsed.routingStrategy || DEFAULT_SETTINGS.routingStrategy,
        roundRobinStickyLimit:
          typeof parsed.roundRobinStickyLimit === 'number' && parsed.roundRobinStickyLimit > 0
            ? parsed.roundRobinStickyLimit
            : DEFAULT_SETTINGS.roundRobinStickyLimit,
        modelsConfig: parsed.modelsConfig,
      }
      return this.cached
    } catch {
      this.cached = { ...DEFAULT_SETTINGS }
      return this.cached
    }
  }

  async save(
    values: Partial<AntigravityPluginSettings> | Record<string, unknown>,
  ): Promise<AntigravityPluginSettings> {
    const current = await this.load()
    const parsedSticky = Number(values['roundRobinStickyLimit'])

    const merged: AntigravityPluginSettings = {
      routingStrategy: (values['routingStrategy'] as RoutingStrategy) || current.routingStrategy,
      roundRobinStickyLimit: !isNaN(parsedSticky) && parsedSticky > 0 ? parsedSticky : current.roundRobinStickyLimit,
      modelsConfig:
        typeof values['modelsConfig'] === 'string' ? values['modelsConfig'] : current.modelsConfig,
    }

    await mkdir(dirname(this.settingsPath), { recursive: true })
    await writeFile(this.settingsPath, JSON.stringify(merged, null, 2), 'utf8')
    this.cached = merged
    return merged
  }

  getCached(): AntigravityPluginSettings {
    return this.cached ?? { ...DEFAULT_SETTINGS }
  }
}
