import { getRuntimeEnv } from "./runtime/platform"
import { readProductEnv } from "@quits/shared/runtimeEnv"

const runtimeEnv =
  typeof process !== "undefined"
    ? getRuntimeEnv()
    : ({} as Record<string, string | undefined>)

const viteDistribution =
  typeof import.meta !== "undefined" &&
  typeof import.meta.env === "object" &&
  import.meta.env !== null &&
  typeof (import.meta.env.VITE_QUITS_DISTRIBUTION ?? import.meta.env.VITE_YAIP_DISTRIBUTION) === "string"
    ? (import.meta.env.VITE_QUITS_DISTRIBUTION ?? import.meta.env.VITE_YAIP_DISTRIBUTION)
    : undefined

const distribution = (readProductEnv(runtimeEnv, "DISTRIBUTION") ?? viteDistribution ?? "selfhost")
  .trim()
  .toLowerCase()

function hasOauthProvider(clientIdEnv: string, clientSecretEnv: string) {
  const clientId = runtimeEnv[clientIdEnv]?.trim()
  const clientSecret = runtimeEnv[clientSecretEnv]?.trim()
  return Boolean(clientId && clientSecret)
}

export const isCloudDistribution = distribution === "cloud"
export const isSelfHostDistribution = !isCloudDistribution

export const billingEnabled =
  isCloudDistribution && readProductEnv(runtimeEnv, "BILLING_ENABLED")?.trim().toLowerCase() !== "false"

export const oauthEnabled =
  hasOauthProvider("BETTER_AUTH_GOOGLE_CLIENT_ID", "BETTER_AUTH_GOOGLE_CLIENT_SECRET") ||
  hasOauthProvider("BETTER_AUTH_GITHUB_CLIENT_ID", "BETTER_AUTH_GITHUB_CLIENT_SECRET")
