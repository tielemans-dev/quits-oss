import { AsyncLocalStorage } from "node:async_hooks"
import type { BetterAuthOptions, BetterAuthPlugin, DBAdapter } from "better-auth"
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

/** Native before hooks retain their originating auth instance even when with-hooks resolves
 * a foreign ambient adapter. Install this for open instances too, without changing admission. */
export function signupOwnershipPlugin(owns?: (origin: object, ambient: object) => boolean): BetterAuthPlugin {
  return {
    id: "signup-transaction-ownership",
    init(context) {
      const owned = new WeakSet<object>([context.adapter])
      const isOwned = (ambient: object) => owns ? owns(context.adapter, ambient) : owned.has(ambient)
      if (!owns) {
        // Keep the configured open database option intact. Track the adapter objects supplied
        // by its own native transactions, which need not equal the initialized base object.
        const nativeTransaction = context.adapter.transaction.bind(context.adapter)
        context.adapter.transaction = async (callback) => {
          if (!isOwned(await getCurrentAdapter(context.adapter))) {
            throw new APIError("INTERNAL_SERVER_ERROR", { code: "signup_failed", message: "Unsupported auth transaction" })
          }
          return nativeTransaction(async (transaction) => {
            owned.add(transaction)
            return callback(transaction)
          })
        }
      }
      return {
        options: {
          databaseHooks: {
            user: {
              create: {
                before: async () => {
                  const ambient = await getCurrentAdapter(context.adapter)
                  if (!isOwned(ambient)) {
                    throw new APIError("INTERNAL_SERVER_ERROR", { code: "signup_failed", message: "Unsupported auth transaction" })
                  }
                },
              },
            },
          },
        },
      }
    },
  }
}

export function signupAdmissionAdapter(input: {
  prisma: PrismaClient
  admission: SignupAdmission
  createDatabaseAdapter?: (prisma: PrismaClient) => unknown
  createTransactionDatabaseAdapter?: (transaction: Prisma.TransactionClient) => unknown
}) {
  const owners = new WeakMap<object, object>()
  const database = (options: BetterAuthOptions): DBAdapter => {
    const owner = {}
    const factory = input.createDatabaseAdapter?.(input.prisma) ?? prismaAdapter(input.prisma, { provider: "postgresql" })
    const base = (factory as (options: BetterAuthOptions) => DBAdapter)(options)
    const owned = new WeakSet<object>()
    const transactions = new AsyncLocalStorage<{
      adapter: DBAdapter
      queues: Set<Array<() => Promise<void>>>
      after: Array<() => Promise<void>>
      failed: boolean
    }>()
    async function captureQueue() {
      const current = transactions.getStore()
      if (current) {
        const store = (await getCurrentDBAdapterAsyncLocalStorage()).getStore()
        if (store && !current.queues.has(store.pendingHooks)) {
          const queue = store.pendingHooks
          current.queues.add(queue)
          current.after.push(...queue.splice(0))
          // Native with-hooks enqueues after the adapter operation returns. Redirect this
          // transaction's queue immediately to retain enqueue order across child scopes.
          queue.push = (...hooks) => current.after.push(...hooks)
        }
      }
    }
    function protect(adapter: DBAdapter, transaction?: Prisma.TransactionClient): DBAdapter {
      const protectedAdapter: DBAdapter = {
        ...adapter,
        transaction: async (callback) => {
          const current = transactions.getStore()
          const ambient = await getCurrentAdapter(protectedAdapter)
          if (!owned.has(ambient)) throw new APIError("INTERNAL_SERVER_ERROR", { code: "signup_failed", message: "Unsupported auth transaction" })
          if (current) {
            try { return await callback(current.adapter) }
            catch (error) { current.failed = true; throw error }
          }
          if (transaction) throw new APIError("INTERNAL_SERVER_ERROR", { code: "signup_failed", message: "Inactive auth transaction" })
          const state = { adapter: protectedAdapter, queues: new Set<Array<() => Promise<void>>>(), after: [] as Array<() => Promise<void>>, failed: false }
          const result = await input.prisma.$transaction(async (tx) => {
            const txFactory = input.createTransactionDatabaseAdapter?.(tx) ?? prismaAdapter(tx, { provider: "postgresql" })
            state.adapter = protect((txFactory as (options: BetterAuthOptions) => DBAdapter)(options), tx)
            return transactions.run(state, async () => {
              const result = await callback(state.adapter)
              if (state.failed) throw new Error("Auth transaction is rollback-only")
              return result
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
          return adapter.create<T, R>({ ...data, data: { ...data.data, email: details.email } })
        },
      }
      // Capture queues on every operation, including the reads used by native deletes.
      // Failures must poison the owner even if a direct internal caller catches them.
      const guarded = new Proxy(protectedAdapter, {
        get(target, property, receiver) {
          const operation = Reflect.get(target, property, receiver)
          if (typeof operation !== "function" || property === "transaction") return operation
          return async (...args: unknown[]) => {
            try {
              await captureQueue()
              return await Reflect.apply(operation, target, args)
            }
            catch (error) {
              const current = transactions.getStore()
              if (current) current.failed = true
              if (property === "create") signupFailure(error)
              throw error
            }
          }
        },
      })
      owned.add(protectedAdapter)
      owned.add(guarded)
      owners.set(protectedAdapter, owner)
      owners.set(guarded, owner)
      return guarded
    }
    return protect(base)
  }
  return Object.assign(database, {
    owns: (origin: object, ambient: object) => owners.has(origin) && owners.get(origin) === owners.get(ambient),
  })
}
