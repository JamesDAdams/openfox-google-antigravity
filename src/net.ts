import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici'

let agent: EnvHttpProxyAgent | undefined
const nativeFetch = globalThis.fetch

function hasProxyEnv(): boolean {
  const env = process.env
  return Boolean(env['HTTPS_PROXY'] || env['https_proxy'] || env['HTTP_PROXY'] || env['http_proxy'])
}

export function proxyFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  if (globalThis.fetch !== nativeFetch || !hasProxyEnv()) return globalThis.fetch(input, init)
  agent ??= new EnvHttpProxyAgent()
  return undiciFetch(input as any, { ...(init as any), dispatcher: agent }) as unknown as Promise<Response>
}
