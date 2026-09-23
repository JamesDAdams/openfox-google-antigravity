import { join } from 'node:path'
import type { ProviderPluginRegistry, ProviderPreset } from 'openfox/provider'
import { FileProviderCredentialStore } from './credentials/file-credential-store.js'
import { AntigravityAuthAdapter } from './auth/antigravity-auth.js'
import { AntigravityTransportAdapter } from './transport/antigravity.js'
import { AntigravityQuotaProvider } from './quota/antigravity.js'
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
  const storageDir = join(registry.runtime.configDirectory, 'plugins', 'openfox-google-antigravity')

  const credentials = new FileProviderCredentialStore(
    join(storageDir, 'credentials.json'),
    join(storageDir, 'credentials.key'),
  )
  const auth = new AntigravityAuthAdapter(credentials)
  registry.registerAuth(auth)
  registry.registerTransport(new AntigravityTransportAdapter(auth))
  registry.registerPreset(antigravityPreset)

  const quotaProvider = new AntigravityQuotaProvider(credentials, {
    configDirectory: registry.runtime.configDirectory,
  })

  await quotaProvider.registerProviders(registry)

  // Register RPC methods for manual quota sync and retrieval
  if (typeof registry.registerRpc === 'function') {
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
