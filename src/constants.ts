export const ANTIGRAVITY_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"

export const ANTIGRAVITY_CLIENT_SECRET = "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"

export const ANTIGRAVITY_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
] as const

export const ANTIGRAVITY_REDIRECT_PORT = 51121

export const ANTIGRAVITY_ENDPOINT_DAILY = "https://daily-cloudcode-pa.sandbox.googleapis.com"
export const ANTIGRAVITY_ENDPOINT_AUTOPUSH = "https://autopush-cloudcode-pa.sandbox.googleapis.com"
export const ANTIGRAVITY_ENDPOINT_PROD = "https://cloudcode-pa.googleapis.com"

export const ANTIGRAVITY_ENDPOINTS = [
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_PROD,
  ANTIGRAVITY_ENDPOINT_AUTOPUSH,
] as const

export const ANTIGRAVITY_LOAD_ENDPOINTS = [
  ANTIGRAVITY_ENDPOINT_PROD,
  ANTIGRAVITY_ENDPOINT_DAILY,
  ANTIGRAVITY_ENDPOINT_AUTOPUSH,
] as const

export const ANTIGRAVITY_DEFAULT_PROJECT_ID = "rising-fact-p41fc"

export const ANTIGRAVITY_VERSION = "1.18.3"

export function getAntigravityHeaders(): { "User-Agent": string; "Client-Metadata": string } {
  const platform = process.platform === "win32" ? "WINDOWS" : "MACOS"
  return {
    "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/${ANTIGRAVITY_VERSION} Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36`,
    "Client-Metadata": `{"ideType":"ANTIGRAVITY","platform":"${platform}","pluginType":"GEMINI"}`,
  }
}
