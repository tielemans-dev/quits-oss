import { betterAuth } from "better-auth"
import { getPrisma } from "./db"
import { buildYaipAuthOptions } from "./runtime/auth-config"
import { createLiveBindingProxy } from "./runtime/live-binding"
import { defaultNodePlatform } from "./runtime/node-platform"
import { getRuntimePlatformOverride } from "./runtime/platform"

type AuthInstance = ReturnType<
  typeof betterAuth<ReturnType<typeof buildYaipAuthOptions>>
>

let authInstance: AuthInstance | undefined
let authPlatformId: string | undefined

export function getAuth() {
  const platform = getRuntimePlatformOverride() ?? defaultNodePlatform

  if (!authInstance || authPlatformId !== platform.id) {
    authInstance = betterAuth(
      buildYaipAuthOptions({
        prisma: getPrisma(),
        env: {
          getEnv: platform.getEnv,
        },
        hooks: platform.getAuthHooks(),
      })
    )
    authPlatformId = platform.id
  }

  return authInstance
}

export const auth = createLiveBindingProxy<AuthInstance>(() => getAuth())
