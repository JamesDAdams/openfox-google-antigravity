import { join } from 'node:path'
import type { ProviderPluginRegistry, ProviderPreset } from 'openfox/provider'
import { FileProviderCredentialStore } from './credentials/file-credential-store.js'
import { AntigravityAuthAdapter } from './auth/antigravity-auth.js'
import { AntigravityTransportAdapter } from './transport/antigravity.js'

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
}
