import type { BetterAuthOptions, DBAdapter } from "better-auth"
import { APIError } from "better-auth/api"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { getCurrentAuthContext } from "@better-auth/core/context"
import type { Prisma, PrismaClient } from "../../../generated/prisma/client"

export type SignupInput = { email: string; inviteCode?: string; request?: Request }
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
  if (value && value.length > 64) assertSignupDecision({ ok: false, code: "invite_invalid" })
  return {
    email: email.trim().toLowerCase(),
    ...(value ? { inviteCode: value.replace(/\s/g, "").toUpperCase() } : {}),
    request,
  }
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
    function protect(adapter: DBAdapter, transaction?: Prisma.TransactionClient): DBAdapter {
      const protectedAdapter: DBAdapter = {
        ...adapter,
        transaction: transaction
          ? async (callback) => callback(protectedAdapter)
          : async (callback) => input.prisma.$transaction(async (tx) => {
            const txFactory = input.createTransactionDatabaseAdapter?.(tx) ?? prismaAdapter(tx, { provider: "postgresql" })
            return callback(protect((txFactory as (options: BetterAuthOptions) => DBAdapter)(options), tx))
          }, { maxWait: 10_000, timeout: 15_000 }).catch(signupFailure),
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
          const decision = assertSignupDecision(await input.admission.authorizeSignUp!(details))
          if (decision.consumeInvite) await decision.consumeInvite(transaction)
          // Both operations use this exact Prisma transaction, including COMMIT failures.
          return adapter.create<T, R>({ ...data, data: { ...data.data, email: details.email } }).catch(signupFailure)
        },
      }
      return protectedAdapter
    }
    return protect(base)
  }
}
