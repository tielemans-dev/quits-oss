import { AsyncLocalStorage } from "node:async_hooks"
import type { BetterAuthOptions, DBAdapter } from "better-auth"
import { APIError } from "better-auth/api"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { getCurrentAuthContext, getCurrentAdapter, getCurrentDBAdapterAsyncLocalStorage } from "@better-auth/core/context"
import type { Prisma, PrismaClient } from "../../../generated/prisma/client"

export type SignupInput = { email: string; inviteCode?: string; inviteCodeInvalid?: true; request?: Request }
export type SignupDecision =
  | { ok: true; consumeInvite?: (transaction: Prisma.TransactionClient) => Promise<void> }
  | { ok: false; code: "not_invited" | "invite_invalid" | "rate_limited"; retryAfter?: number }

export type SignupAdmission = {
  /** Read-only preflight. Called before email account lookup and again at user creation.
   * Consumption must use only the supplied transaction client, recheck email/expiry/revocation,
   * and atomically claim a single use. Throw invite_invalid if the claim loses a race.
   */
  authorizeSignUp?: (input: SignupInput) => Promise<SignupDecision>
  /** Called once per email attempt or other user creation, before admission. */
  admitSignUpAttempt?: (input: SignupInput) => Promise<SignupDecision>
}

export function assertSignupDecision(decision: SignupDecision) {
  if (decision.ok) return decision
  const limited = decision.code === "rate_limited"
  throw new APIError(limited ? "TOO_MANY_REQUESTS" : "FORBIDDEN", {
    code: decision.code,
    message: limited ? "Too many signup attempts" : "Signup admission denied",
  }, limited ? { "Retry-After": String(Math.max(1, Math.min(3600, Math.ceil(decision.retryAfter ?? 60)))) } : undefined)
}

export function signupInput(email: string, body?: Record<string, unknown>, request?: Request): SignupInput {
  const value = typeof body?.inviteCode === "string" ? body.inviteCode : request?.headers.get("x-quits-invite")
  const invalid = Boolean(value && (value.length > 64 || !value.replace(/\s/g, "")))
  return {
    email: email.trim().toLowerCase(),
    ...(invalid ? { inviteCodeInvalid: true as const } : value ? { inviteCode: value.replace(/\s/g, "").toUpperCase() } : {}),
    request,
  }
}

/** Invalid input can admit an address through an allowlist, never through invite consumption. */
export async function authorizeSignup(admission: SignupAdmission, details: SignupInput) {
  const decision = await admission.authorizeSignUp!(details)
  if (details.inviteCodeInvalid && ((decision.ok && decision.consumeInvite) || (!decision.ok && decision.code === "not_invited"))) {
    return assertSignupDecision({ ok: false, code: "invite_invalid" })
  }
  return assertSignupDecision(decision)
}

/** No policy is installed for an ordinary self-host. A configured restriction fails closed. */
export function signupMode(value?: string): "open" | "invite_only" {
  return value === undefined || value.trim() === "" || value.trim() === "open" ? "open" : "invite_only"
}

export function resolveSignupAdmission(value: string | undefined, hooks: SignupAdmission): SignupAdmission {
  return {
    ...hooks,
    authorizeSignUp: hooks.authorizeSignUp ?? (signupMode(value) === "invite_only"
      ? async () => ({ ok: false as const, code: "not_invited" as const })
      : hooks.admitSignUpAttempt ? async () => ({ ok: true as const }) : undefined),
  }
}

function signupFailure(error: unknown): never {
  if (error instanceof Error && error.name === "APIError") throw error
  console.error("Signup transaction failed")
  throw new APIError("INTERNAL_SERVER_ERROR", { code: "signup_failed", message: "Could not create account" })
}

export function signupAdmissionAdapter(input: {
  prisma: PrismaClient
  admission: SignupAdmission
  createDatabaseAdapter?: (prisma: PrismaClient) => unknown
  createTransactionDatabaseAdapter?: (transaction: Prisma.TransactionClient) => unknown
}) {
  return (options: BetterAuthOptions): DBAdapter => {
    const factory = input.createDatabaseAdapter?.(input.prisma) ?? prismaAdapter(input.prisma, { provider: "postgresql" })
    const base = (factory as (options: BetterAuthOptions) => DBAdapter)(options)
    const owned = new WeakSet<object>()
    const transactions = new AsyncLocalStorage<{
      adapter: DBAdapter
      queues: Set<Array<() => Promise<void>>>
      after: Array<() => Promise<void>>
      failed: boolean
    }>()
    function protect(adapter: DBAdapter, transaction?: Prisma.TransactionClient): DBAdapter {
      const protectedAdapter: DBAdapter = {
        ...adapter,
        transaction: async (callback) => {
          const current = transactions.getStore()
          const ambient = await getCurrentAdapter(protectedAdapter)
          if (!owned.has(ambient)) throw new APIError("INTERNAL_SERVER_ERROR", { code: "signup_failed", message: "Unsupported auth transaction" })
          const drain = (state: NonNullable<ReturnType<typeof transactions.getStore>>) => {
            for (const queue of state.queues) state.after.push(...queue.splice(0))
          }
          if (current) {
            try { return await callback(current.adapter) }
            catch (error) { current.failed = true; throw error }
            finally { drain(current) }
          }
          if (transaction) throw new APIError("INTERNAL_SERVER_ERROR", { code: "signup_failed", message: "Inactive auth transaction" })
          const state = { adapter: protectedAdapter, queues: new Set<Array<() => Promise<void>>>(), after: [] as Array<() => Promise<void>>, failed: false }
          const result = await input.prisma.$transaction(async (tx) => {
            const txFactory = input.createTransactionDatabaseAdapter?.(tx) ?? prismaAdapter(tx, { provider: "postgresql" })
            state.adapter = protect((txFactory as (options: BetterAuthOptions) => DBAdapter)(options), tx)
            return transactions.run(state, async () => {
              try {
                const result = await callback(state.adapter)
                if (state.failed) throw new Error("Nested auth transaction failed")
                return result
              } finally { drain(state) }
            })
          }, { maxWait: 10_000, timeout: 15_000 }).catch(signupFailure)
          // Better Auth 1.5.4 otherwise runs child hooks before outer commit, even on failure.
          // Only this owning transaction may dispatch the queues, after successful COMMIT.
          for (const hook of state.after) await hook()
          return result
        },
        create: async <T extends Record<string, unknown>, R = T>(data: {
          model: string; data: Omit<T, "id">; select?: string[]; forceAllowId?: boolean
        }): Promise<R> => {
          const current = transactions.getStore()
          if (current) {
            const store = (await getCurrentDBAdapterAsyncLocalStorage()).getStore()
            if (store) current.queues.add(store.pendingHooks)
          }
          if (data.model !== "user") return adapter.create<T, R>(data)
          if (!transaction) return protectedAdapter.transaction((txAdapter) => txAdapter.create<T, R>(data))
          const context = await getCurrentAuthContext().catch(() => null)
          const details = signupInput(String(data.data.email ?? ""), context?.body, context?.request)
          // The email endpoint has already admitted this attempt before account lookup.
          if (context?.path !== "/sign-up/email" && input.admission.admitSignUpAttempt) {
            assertSignupDecision(await input.admission.admitSignUpAttempt(details))
          }
          const decision = await authorizeSignup(input.admission, details)
          if (decision.consumeInvite) await decision.consumeInvite(transaction)
          // Both operations use this exact Prisma transaction, including COMMIT failures.
          return adapter.create<T, R>({ ...data, data: { ...data.data, email: details.email } }).catch(signupFailure)
        },
      }
      owned.add(protectedAdapter)
      return protectedAdapter
    }
    return protect(base)
  }
}
