import { join } from 'node:path'
import type { ProviderPluginRegistry, ProviderPreset } from 'openfox/provider'
import { FileProviderCredentialStore } from './credentials/file-credential-store.js'
import { AntigravityAuthAdapter } from './auth/antigravity-auth.js'
import { AntigravityTransportAdapter } from './transport/antigravity.js'
import { AntigravityQuotaProvider } from './quota/antigravity.js'
import { DEFAULT_ANTIGRAVITY_MODELS } from './catalog/models-default.js'
import { PluginSettingsStore } from './settings.js'
import { buildDeclarativeAuthComponent } from './ui.js'
import { readAntigravityProviderIds } from './providers.js'
import './quota/contract.js'

const antigravityPreset: ProviderPreset = {
  id: 'google-antigravity',
  name: 'Google Antigravity',
  description: 'Use your Google AI Pro subscription via Antigravity (Cloud Code Assist) OAuth authentication.',
  requiresAuth: true,
  authAdapter: 'google-antigravity-auth',
  transportAdapter: 'google-antigravity-transport',
  defaults: {
    name: 'Google Antigravity',
    url: 'https://cloudcode-pa.googleapis.com',
    backend: 'openai',
    models: DEFAULT_ANTIGRAVITY_MODELS,
  },
  connectLabel: 'Connect Google',
  disconnectLabel: 'Disconnect',
  missingPluginMessage: 'Install openfox-google-antigravity to use this provider.',
}

export { AntigravityAuthAdapter } from './auth/antigravity-auth.js'
export { AntigravityTransportAdapter } from './transport/antigravity.js'
export {
  AntigravityQuotaProvider,
  type AntigravityProviderAccount,
  type AntigravityQuotaProviderOptions,
} from './quota/antigravity.js'

export async function register(registry: ProviderPluginRegistry): Promise<void> {
  // Capture the plugin context once: `registry.context` is only valid while the
  // plugin is registering, so reading it lazily from event handlers/RPCs throws
  // (which silently killed settings reads and UI publishes).
  const context = registry.context
  const storageDir = join(registry.runtime.configDirectory, 'plugins', 'openfox-google-antigravity')
  const settingsStore = new PluginSettingsStore(join(storageDir, 'settings.json'))
  await settingsStore.load()

  const credentials = new FileProviderCredentialStore(
    join(storageDir, 'credentials.json'),
    join(storageDir, 'credentials.key'),
  )
  const auth = new AntigravityAuthAdapter(credentials)
  registry.registerAuth(auth)

  const getSettings = () => {
    try {
      return {
        ...settingsStore.getCached(),
        ...(context?.settings?.() ?? {}),
      }
    } catch {
      return settingsStore.getCached() as unknown as Record<string, unknown>
    }
  }

  // Accounts are owned by the provider that created them. Credentials written
  // before that rule existed carry a placeholder owner (or none) and would be
  // invisible; re-link them when a single Antigravity provider owns the plugin.
  const providerIds = await readAntigravityProviderIds(registry.runtime.configDirectory)
  const relinked = await auth.relinkOrphanedAccounts(providerIds)
  if (relinked.relinked > 0) {
    context?.logger?.info(
      `Re-linked ${relinked.relinked} Google Antigravity account(s) to the only configured provider`,
    )
  }
  if (relinked.orphaned > 0) {
    context?.logger?.warn(
      `${relinked.orphaned} Google Antigravity account(s) have no known provider and were left untouched`,
    )
  }

  if (typeof registry.registerSettings === 'function') {
    ;(registry as any).registerSettings({
      title: {
        en: 'Google Antigravity Settings',
        fr: 'Paramètres Google Antigravity',
      },
      description: {
        en: 'Configure model definitions and options for Google Antigravity.',
        fr: 'Configurer les définitions et options des modèles Google Antigravity.',
      },
      fields: [
        {
          key: 'modelsConfig',
          type: 'textarea',
          label: { en: 'Models Configuration (JSON)', fr: 'Configuration des modèles (JSON)' },
          description: {
            en: 'JSON configuration for the available Antigravity model families and their reasoning efforts. Tier-specific catalog ids are resolved internally by the transport.',
            fr: 'Configuration JSON des familles de modèles Antigravity disponibles et de leurs efforts de réflexion. Les identifiants de catalogue par palier sont résolus en interne par le transport.',
          },
          default: JSON.stringify(DEFAULT_ANTIGRAVITY_MODELS, null, 2),
          defaultValue: JSON.stringify(DEFAULT_ANTIGRAVITY_MODELS, null, 2),
        },
        {
          key: 'mergeSubscriptions',
          type: 'boolean',
          label: {
            en: 'Merge identical subscriptions',
            fr: 'Fusionner les abonnements identiques',
          },
          description: {
            en: 'Combine multiple accounts for the same provider (e.g. 4 Google Antigravity subscriptions) into a single card with summed quota limits.',
            fr: 'Combiner plusieurs comptes d’un même fournisseur (ex. 4 abonnements Google Antigravity) en une seule carte avec les quotas cumulés.',
          },
          default: true,
          defaultValue: true,
        },
      ],
    })
  }

  registry.registerTransport(new AntigravityTransportAdapter(auth, getSettings, context?.logger))
  registry.registerPreset(antigravityPreset)

  const quotaProvider = new AntigravityQuotaProvider(credentials, {
    configDirectory: registry.runtime.configDirectory,
    getSettings,
  })

  await quotaProvider.registerProviders(registry)

  // Live content for the provider auth zone: the host calls this RPC with the
  // provider currently being configured, so the list only ever shows that
  // provider's accounts and refreshes on its own after a login/logout.
  const buildAuthContent = async (providerId?: string) => {
    const accounts = providerId ? await auth.listAccounts(providerId, { probeLive: true }) : []
    const isAuthenticating = providerId ? auth.isLoginInProgress(providerId) : false
    return buildDeclarativeAuthComponent(
      accounts,
      settingsStore.getCached(),
      providerId,
      isAuthenticating,
      auth.getLoginError(providerId),
    )
  }

  const publishAuthContent = async (providerId?: string) => {
    try {
      context?.publish?.(undefined, 'content', await buildAuthContent(providerId))
    } catch {
      // Publishing is best-effort: the zone's contentSource refreshes anyway.
    }
  }

  auth.onAccountChange = (providerId?: string) => {
    void quotaProvider.syncQuota(registry)
    void publishAuthContent(providerId)
  }

  // Replace the default single-account connect box with the multi-account UI.
  // The static replacement is provider-agnostic (no accounts) so it can never
  // leak another provider's accounts while the live content is loading.
  if (typeof registry.registerUiOverride === 'function') {
    registry.registerUiOverride({
      id: 'antigravity-modal-auth-override',
      zone: 'provider.modal.auth',
      mode: 'replace',
      visibleWhen: {
        eq: {
          transportAdapter: 'google-antigravity-transport',
        },
      },
      replacement: buildDeclarativeAuthComponent([], settingsStore.getCached()),
      contentSource: { kind: 'rpc', method: 'antigravity.getAuthUi', refreshMs: 3000 },
    })
  }

  // Register RPC methods for manual quota sync, account management and retrieval
  if (typeof registry.registerRpc === 'function') {
    const readProviderId = (params: Record<string, unknown> | undefined): string | undefined => {
      const value = params?.['providerId']
      return typeof value === 'string' && value ? value : undefined
    }

    // Live auth UI for the provider being configured (see the contentSource).
    registry.registerRpc('antigravity.getAuthUi', async (params) => {
      const providerId = readProviderId(params)
      return { content: await buildAuthContent(providerId) }
    })

    registry.registerRpc('antigravity.addAccount', async (params) => {
      const providerId = readProviderId(params)
      if (!providerId) {
        return { success: false, error: 'providerId is required to link a Google account to a provider' }
      }
      const { challenge, completion } = await auth.beginLogin({ providerId })
      void publishAuthContent(providerId)
      void completion
        .then(async () => {
          await quotaProvider.syncQuota(registry)
          await publishAuthContent(providerId)
        })
        .catch(async () => {
          await publishAuthContent(providerId)
        })
      // The account only exists once the OAuth flow completes; the zone's
      // contentSource picks it up, so no stale content is returned here.
      return { challenge }
    })

    registry.registerRpc('antigravity.cancelLogin', async (params) => {
      const providerId = readProviderId(params)
      if (providerId) {
        auth.cancelLogin(providerId)
        await publishAuthContent(providerId)
      }
      return { success: true }
    })

    registry.registerRpc('antigravity.listAccounts', async (params) => {
      const providerId = readProviderId(params)
      return { accounts: await auth.listAccounts(providerId) }
    })

    registry.registerRpc('antigravity.reorderAccount', async (params) => {
      const credentialRef = typeof params?.['credentialRef'] === 'string' ? params['credentialRef'] : undefined
      const providerId = readProviderId(params)
      const direction = params?.['direction'] === 'up' || params?.['direction'] === 'down' ? params['direction'] : undefined
      if (!credentialRef) return { success: false, error: 'credentialRef is required' }
      if (!providerId) return { success: false, error: 'providerId is required' }
      if (!direction) return { success: false, error: 'direction must be "up" or "down"' }
      if (!(await auth.ownsAccount(providerId, credentialRef))) {
        return { success: false, error: 'Account does not belong to this provider' }
      }
      await auth.reorderAccount(providerId, credentialRef, direction)
      await quotaProvider.syncQuota(registry)
      await publishAuthContent(providerId)
      return { success: true }
    })

    registry.registerRpc('antigravity.removeAccount', async (params) => {
      const credentialRef = typeof params?.['credentialRef'] === 'string' ? params['credentialRef'] : undefined
      const providerId = readProviderId(params)
      if (!credentialRef) return { success: false, error: 'credentialRef is required' }
      if (!providerId) return { success: false, error: 'providerId is required' }
      if (!(await auth.ownsAccount(providerId, credentialRef))) {
        return { success: false, error: 'Account does not belong to this provider' }
      }
      await auth.logout(credentialRef)
      await quotaProvider.syncQuota(registry)
      await publishAuthContent(providerId)
      return { success: true }
    })

    registry.registerRpc('antigravity.setRoutingStrategy', async (params) => {
      const strategy = (params?.['value'] || params?.['strategy']) as any
      if (!strategy) return { success: false }
      await settingsStore.save({ routingStrategy: strategy })
      await publishAuthContent(readProviderId(params))
      return { success: true }
    })

    registry.registerRpc('antigravity.setStickyLimit', async (params) => {
      const limit = Number(params?.['value'] || params?.['limit'])
      if (isNaN(limit) || limit <= 0) return { success: false }
      await settingsStore.save({ roundRobinStickyLimit: limit })
      await publishAuthContent(readProviderId(params))
      return { success: true }
    })

    registry.registerRpc('antigravity.updateAccount', async (params) => {
      const credentialRef = typeof params?.['credentialRef'] === 'string' ? params['credentialRef'] : undefined
      const providerId = readProviderId(params)
      if (!credentialRef) return { success: false, error: 'credentialRef is required' }
      if (!providerId) return { success: false, error: 'providerId is required' }
      if (!(await auth.ownsAccount(providerId, credentialRef))) {
        return { success: false, error: 'Account does not belong to this provider' }
      }
      await auth.updateAccount(credentialRef, {
        priority: typeof params['priority'] === 'number' ? params['priority'] : undefined,
        cost: typeof params['cost'] === 'number' ? params['cost'] : undefined,
        disabled: typeof params['disabled'] === 'boolean' ? params['disabled'] : undefined,
      })
      await publishAuthContent(providerId)
      return { success: true }
    })

    registry.registerRpc('antigravity.getQuota', async (params) => {
      const providerId = typeof params?.['providerId'] === 'string' ? params['providerId'] : undefined
      if (providerId) {
        const accounts = await quotaProvider.discoverProviders()
        const target = accounts.find((a) => a.id === providerId || a.sourceId === providerId)
        if (target) {
          const source = await quotaProvider.getQuotaForAccount(target)
          return { source }
        }
      }
      const sources = await quotaProvider.getAllQuotaSources()
      return { sources }
    })

    registry.registerRpc('antigravity.syncQuota', async () => {
      return await quotaProvider.syncQuota(registry)
    })
  }

  // Register tool for LLM to query all Google Antigravity quotas
  if (typeof registry.registerTool === 'function') {
    registry.registerTool({
      name: 'get_antigravity_quota',
      description: 'Retrieve current model quota limits and usage across all configured Google Antigravity provider accounts.',
      parameters: {
        type: 'object',
        properties: {
          providerId: {
            type: 'string',
            description: 'Optional Google Antigravity provider ID or source ID filter',
          },
        },
      },
      execute: async (args) => {
        const providerId = typeof args['providerId'] === 'string' ? args['providerId'] : undefined
        if (providerId) {
          const accounts = await quotaProvider.discoverProviders()
          const target = accounts.find((a) => a.id === providerId || a.sourceId === providerId)
          if (target) {
            const source = await quotaProvider.getQuotaForAccount(target)
            return {
              success: true,
              output: JSON.stringify(source, null, 2),
            }
          }
        }
        const sources = await quotaProvider.getAllQuotaSources()
        return {
          success: true,
          output: JSON.stringify({ sources }, null, 2),
        }
      },
    })
  }

  // Register turn completion hook to keep quotas updated
  if (typeof registry.registerHook === 'function') {
    registry.registerHook('turn.completed', async () => {
      try {
        await quotaProvider.syncQuota(registry)
      } catch {
        // Silently ignore background quota sync failure
      }
    })
  }
}
