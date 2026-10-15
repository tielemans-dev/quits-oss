import { TRPCError } from "@trpc/server"
import { isValidDanishCvr } from "@quits/contracts/onboarding"
import type { Prisma } from "../../../generated/prisma/client"
import { getRuntimeExtensions } from "./extensions"

type AdmissionTransaction = Pick<Prisma.TransactionClient, "$executeRaw" | "$queryRaw">
type TrialStore = Pick<Prisma.TransactionClient, "cvrTrialUsage">

/** Call after registry verification, in the transaction that persists the CVR. */
export async function assertOrganizationCvrAvailable(tx: AdmissionTransaction, input: {
  cvr: string; organizationId: string; cloud: boolean
}) {
  if (!input.cloud || !getRuntimeExtensions().some(extension => extension.enforceCvrUniqueness)) return
  assertCvr(input.cvr)
  // A transaction-scoped lock works across processes and releases on rollback. All identity
  // writers must hold it through their tax-ID write, using PostgreSQL READ COMMITTED.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(154, ${Number(input.cvr)})`
  const duplicates = await tx.$queryRaw<{ organizationId: string }[]>`
    SELECT "organizationId" FROM organization_tax_id
    WHERE "organizationId" <> ${input.organizationId}
      AND lower(trim(scheme)) IN ('cvr', 'dk_cvr', 'vat', 'dk_vat')
      AND ("countryCode" IS NULL OR upper(trim("countryCode")) IN ('', 'DK'))
      AND regexp_replace(regexp_replace(upper(value), '[[:space:]./\\-]', '', 'g'), '^DK', '') = ${input.cvr}
    LIMIT 1`
  if (duplicates.length) throw new TRPCError({ code: "CONFLICT", message: "cvr.alreadyRegistered" })
}

/** Eligibility is informational. Only an atomic claim can authorize a new trial. */
export async function isCvrTrialEligible(store: TrialStore, cvr: string): Promise<boolean> {
  assertCvr(cvr)
  return await store.cvrTrialUsage.findUnique({ where: { cvr } }) === null
}

/** Hosted billing must claim alongside its durable trial grant in the same transaction.
 * A false result never authorizes a new trial, including retries by the same organization.
 */
export async function claimCvrTrial(store: TrialStore, cvr: string, organizationId: string): Promise<boolean> {
  assertCvr(cvr)
  const result = await store.cvrTrialUsage.createMany({ data: [{ cvr, firstOrganizationId: organizationId }], skipDuplicates: true })
  return result.count === 1
}

function assertCvr(cvr: string) {
  if (!isValidDanishCvr(cvr)) throw new TRPCError({ code: "BAD_REQUEST", message: "cvr.invalid" })
}
