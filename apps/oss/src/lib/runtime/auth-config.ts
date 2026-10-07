import type { BetterAuthOptions, DBAdapter } from "better-auth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { APIError, createAuthMiddleware, requestPasswordReset, resetPassword } from "better-auth/api"
import { createInternalAdapter } from "better-auth/db"
import { runWithAdapter } from "@better-auth/core/context"
import { organization } from "better-auth/plugins"
import { tanstackStartCookies } from "better-auth/tanstack-start"
import { readBooleanEnv, resolveUrlOrigin } from "@quits/shared/runtimeEnv"

import type { Prisma, PrismaClient } from "../../../generated/prisma/client"

import { getConfiguredSocialProviders } from "../auth/providers"
import { sendInvitationEmail } from "../email"
import { sendPasswordResetEmail } from "../emails/password-reset-email"
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, PASSWORD_RESET_EXPIRES_IN } from "../auth/password-policy"
import { admitRecoveryRequest, recoveryClientKey } from "../auth/password-recovery"
import { selectedEmailProvider, readSmtpConfiguration, requireSmtpFromEmail } from "../email-provider-config"
import { ac, accountant, admin, member } from "../permissions"

export type AuthHooks = {
  /** Keep background delivery alive for the runtime's request lifetime (e.g. an execution context). */
  runInBackground?: (task: Promise<void>) => void
  /** Return a client key only from authenticated proxy metadata or the direct connection. Never use arbitrary forwarding headers. */
  getRecoveryClientKey?: (request?: Request) => string | Promise<string>
  /** Hosted runtimes can provide their own transactional email delivery. */
  sendResetPassword?: NonNullable<BetterAuthOptions["emailAndPassword"]>["sendResetPassword"]
  createDatabaseAdapter?: (prisma: PrismaClient) => unknown
  /** Must bind every auth query to this transaction, without a separate session-read connection. */
  createTransactionDatabaseAdapter?: (prisma: Prisma.TransactionClient) => unknown
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
      if (!betterAuthUrl) return
      const provider = selectedEmailProvider(env.getEnv("EMAIL_PROVIDER") ?? "")
      if (provider === "resend" && !env.getEnv("RESEND_API_KEY")) return
      if (provider === "smtp") {
        readSmtpConfiguration(envRecord)
        requireSmtpFromEmail(envRecord)
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
      }, { environment: envRecord })
    },
  })
  const cookiesPlugin = tanstackStartCookies()

  return {
    ...(betterAuthUrl ? { baseURL: betterAuthUrl } : {}),
    rateLimit: {
      customRules: {
        // Recovery uses atomic database admission below. Do not also use post-response memory
        // counters keyed by client-controlled forwarding headers.
        "/request-password-reset": false as const,
        "/reset-password": false as const,
      },
    },
    database:
      hooks.createDatabaseAdapter?.(input.prisma) ??
      prismaAdapter(input.prisma, {
        provider: "postgresql",
      }),
    ...(trustedOrigins.length > 0 ? { trustedOrigins } : {}),
    advanced: {
      backgroundTasks: {
        handler(task: Promise<unknown>) {
          const safeTask = task.then(() => {}).catch(() => {
            console.error("Auth background task failed")
          })
          if (hooks.runInBackground) hooks.runInBackground(safeTask)
          else void safeTask
        },
      },
      ...(crossSubDomainEnabled ? {
        crossSubDomainCookies: {
          enabled: true,
          ...(crossSubDomainDomain ? { domain: crossSubDomainDomain } : {}),
        },
      } : {}),
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/request-password-reset" && ctx.path !== "/reset-password") return
        const clientKey = hooks.getRecoveryClientKey
          ? await hooks.getRecoveryClientKey(ctx.request)
          : recoveryClientKey(ctx.request, env.getEnv("QUITS_AUTH_TRUSTED_PROXIES") ?? env.getEnv("YAIP_AUTH_TRUSTED_PROXIES"))
        await admitRecoveryRequest(input.prisma, ctx.path, clientKey, env.getEnv("BETTER_AUTH_SECRET"))
        const requesting = ctx.path === "/request-password-reset"
        if (requesting && typeof ctx.body?.email !== "string") return
        // Let native schema validation reject non-string body tokens before normalization.
        if (!requesting && ctx.body?.token !== undefined && typeof ctx.body.token !== "string") return
        // Match the native endpoint's truthy fallback, then give it the exact token we lock.
        const token = ctx.body?.token || ctx.query?.token
        if (!requesting && typeof token !== "string") return
        // The native endpoint remains responsible for validation, hashing, token consumption and
        // session revocation. Lock its existing record until all those writes commit together.
        const result = await input.prisma.$transaction(async (tx) => {
          const adapterFactory = hooks.createTransactionDatabaseAdapter?.(tx) ?? prismaAdapter(tx, { provider: "postgresql" })
          const adapter = (adapterFactory as (options: BetterAuthOptions) => DBAdapter)(ctx.context.options)
          const internalAdapter = createInternalAdapter(adapter, {
            ...ctx.context,
            options: {
              ...ctx.context.options,
              verification: { ...ctx.context.options.verification, disableCleanup: true },
            },
            hooks: [ctx.context.options.databaseHooks ?? {}],
          })
          // Lock the user before any reset token. Different tokens for one user must serialize,
          // and token issuance uses the same lock so it cannot race sibling invalidation.
          if (requesting) {
            await tx.$queryRaw`SELECT id FROM "user" WHERE email = ${ctx.body.email.toLowerCase()} FOR UPDATE`
            return runWithAdapter(adapter, () => requestPasswordReset({
              ...ctx, method: "POST", body: ctx.body as { email: string; redirectTo?: string },
              context: { ...ctx.context, internalAdapter },
              asResponse: false, returnHeaders: false, returnStatus: false,
            }))
          }
          const verification = await internalAdapter.findVerificationValue(`reset-password:${token}`)
          if (verification) await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${verification.value} FOR UPDATE`
          await tx.$queryRaw`SELECT id FROM verification WHERE identifier = ${`reset-password:${token}`} FOR UPDATE`
          // Native expiry validation still applies. Its broad expired-record cleanup must not
          // acquire other verification locks while this transaction holds a reset-record lock.
          const resetResult = await runWithAdapter(adapter, () => resetPassword({
            ...ctx,
            method: "POST",
            body: { ...ctx.body, token } as { token: string; newPassword: string },
            context: { ...ctx.context, internalAdapter },
            asResponse: false,
            returnHeaders: false,
            returnStatus: false,
          }))
          if (verification) await adapter.deleteMany({
            model: "verification",
            where: [
              { field: "value", value: verification.value },
              { field: "identifier", operator: "starts_with", value: "reset-password:" },
            ],
          })
          return resetResult
        }, { maxWait: 10_000, timeout: 15_000 }).catch((error: unknown) => {
          // Native schema errors use Better Call's base APIError, which is not an instance of
          // Better Auth's exported subclass in newer versions. Match native error recognition.
          if (error instanceof APIError || (error instanceof Error && error.name === "APIError")) throw error
          console.error("Password reset transaction failed")
          throw new APIError("INTERNAL_SERVER_ERROR", { message: "Could not reset password. Please try again." })
        })
        // Better Auth otherwise copies request headers onto an early hook response, including
        // Content-Length and cookies. Supply the completed response so it keeps response headers.
        return ctx.json(result, Response.json(result))
      }),
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      resetPasswordTokenExpiresIn: PASSWORD_RESET_EXPIRES_IN,
      revokeSessionsOnPasswordReset: true,
      async sendResetPassword(data: Parameters<NonNullable<AuthHooks["sendResetPassword"]>>[0], request?: Request) {
        try {
          if (hooks.sendResetPassword) {
            await hooks.sendResetPassword(data, request)
          } else {
            const fromEmail = env.getEnv("FROM_EMAIL")?.trim()
            if (selectedEmailProvider(envRecord.EMAIL_PROVIDER ?? "") === "smtp") requireSmtpFromEmail(envRecord)
            await sendPasswordResetEmail({
              to: data.user.email,
              name: data.user.name,
              resetUrl: data.url,
              fromEmail: fromEmail || "noreply@yaip.app",
              locale: request?.headers.get("accept-language")?.split(",")[0],
            }, { environment: envRecord })
          }
        } catch {
          // Preserve the same response for existing and unknown accounts, even on delivery failure.
          // Never include the provider error, reset URL, token, password, or recipient in logs.
          console.error("Password reset email delivery failed")
        }
      },
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
