import { prismaAdapter } from "better-auth/adapters/prisma"
import { organization } from "better-auth/plugins"
import { tanstackStartCookies } from "better-auth/tanstack-start"
import { readBooleanEnv, resolveUrlOrigin } from "@quits/shared/runtimeEnv"

import type { PrismaClient } from "../../../generated/prisma/client"

import { getConfiguredSocialProviders } from "../auth/providers"
import { sendInvitationEmail } from "../email"
import { ac, accountant, admin, member } from "../permissions"

export type AuthHooks = {
  createDatabaseAdapter?: (prisma: PrismaClient) => unknown
  password?: {
    hash?: (password: string) => Promise<string>
    verify?: (input: { hash: string; password: string }) => Promise<boolean>
  }
}

type AuthEnvReader = {
  getEnv: (name: string) => string | undefined
}

function createEnvRecord(reader: AuthEnvReader) {
  return new Proxy({} as Record<string, string | undefined>, {
    get(_target, property) {
      return typeof property === "string" ? reader.getEnv(property) : undefined
    },
  })
}

export function buildQuitsAuthOptions(input: {
  prisma: PrismaClient
  env: AuthEnvReader
  hooks?: AuthHooks
}) {
  const hooks = input.hooks ?? {}
  const env = input.env
  const envRecord = createEnvRecord(env)
  const socialProviders = getConfiguredSocialProviders(envRecord)
  const distribution = ((env.getEnv("QUITS_DISTRIBUTION") ?? env.getEnv("YAIP_DISTRIBUTION")) ?? "selfhost").trim().toLowerCase()
  const cloudDistribution = distribution === "cloud"
  const betterAuthUrl = env.getEnv("BETTER_AUTH_URL")
  const trustedOrigins = Array.from(
    new Set(
      [
        resolveUrlOrigin(betterAuthUrl),
        resolveUrlOrigin((env.getEnv("QUITS_SHELL_ORIGIN") ?? env.getEnv("YAIP_SHELL_ORIGIN"))),
        resolveUrlOrigin((env.getEnv("QUITS_APP_ORIGIN") ?? env.getEnv("YAIP_APP_ORIGIN"))),
      ].filter((origin): origin is string => Boolean(origin))
    )
  )

  const crossSubDomainEnabled = readBooleanEnv(
    (env.getEnv("QUITS_AUTH_CROSS_SUBDOMAIN") ?? env.getEnv("YAIP_AUTH_CROSS_SUBDOMAIN")),
    cloudDistribution
  )
  const crossSubDomainDomain = (env.getEnv("QUITS_AUTH_COOKIE_DOMAIN") ?? env.getEnv("YAIP_AUTH_COOKIE_DOMAIN"))?.trim()
  const password = hooks.password
  // A tuple (not an array) keeps plugin-specific session fields in Better Auth's inferred types.
  const organizationPlugin = organization({
    ac,
    roles: { admin, member, accountant },
    // Organization deletion must not remove financial records or their evidence.
    disableOrganizationDeletion: true,
    allowUserToCreateOrganization: true,
    creatorRole: "admin",
    membershipLimit: 50,
    async sendInvitationEmail(data) {
      if (!env.getEnv("RESEND_API_KEY") || !betterAuthUrl) {
        return
      }

      const invitationUrl = `${betterAuthUrl}/accept-invitation/${data.id}`
      const orgSettings = await input.prisma.orgSettings.findUnique({
        where: { organizationId: data.organization.id },
        select: { locale: true },
      })

      await sendInvitationEmail({
        to: data.email,
        inviterName: data.inviter.user.name,
        orgName: data.organization.name,
        invitationUrl,
        locale: orgSettings?.locale,
      })
    },
  })
  const cookiesPlugin = tanstackStartCookies()

  return {
    database:
      hooks.createDatabaseAdapter?.(input.prisma) ??
      prismaAdapter(input.prisma, {
        provider: "postgresql",
      }),
    ...(trustedOrigins.length > 0 ? { trustedOrigins } : {}),
    ...(crossSubDomainEnabled
      ? {
          advanced: {
            crossSubDomainCookies: {
              enabled: true,
              ...(crossSubDomainDomain ? { domain: crossSubDomainDomain } : {}),
            },
          },
        }
      : {}),
    emailAndPassword: {
      enabled: true,
      ...(password?.hash || password?.verify
        ? {
            password: {
              ...(password.hash ? { hash: password.hash } : {}),
              ...(password.verify ? { verify: password.verify } : {}),
            },
          }
        : {}),
    },
    socialProviders: Object.keys(socialProviders).length
      ? socialProviders
      : undefined,
    plugins: [organizationPlugin, cookiesPlugin] as [
      typeof organizationPlugin,
      typeof cookiesPlugin,
    ],
  }
}

/** @deprecated Renamed to `buildQuitsAuthOptions`. */
export const buildYaipAuthOptions = buildQuitsAuthOptions
