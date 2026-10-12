import { TRPCError } from "@trpc/server"
import { onboardingV2ConfirmationResultSchema, type ConfirmOnboardingV2 } from "@quits/contracts/onboarding"
import { billingProvider } from "../billing"
import { prisma } from "../db"
import { buildDkPresets } from "./dk-presets"
import { hasIssuedDocuments } from "../../domain/documents/base-currency"

/** One final save. The organization lock also serializes confirms before a settings row exists. */
export async function confirmOnboardingV2(organizationId: string, input: ConfirmOnboardingV2, signupEmail: string) {
  // Lifecycle hooks can make several bounded provider requests. Allow their total latency
  // without changing the provider's individual request deadlines.
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "organization" WHERE id = ${organizationId} FOR NO KEY UPDATE`
    // Match the settings lock used by document issuance before checking/resetting its counters.
    await tx.$queryRaw`SELECT id FROM "org_settings" WHERE "organizationId" = ${organizationId} FOR UPDATE`
    let existing = await tx.orgSettings.findUnique({ where: { organizationId } })
    if (!existing) {
      // Insert inside confirm, then lock before checking issued documents. Another writer may
      // have created settings after the first read, so re-read under the same issuance lock.
      await tx.orgSettings.upsert({ where: { organizationId }, create: { organizationId, ...buildDkPresets(input, signupEmail) }, update: {} })
      await tx.$queryRaw`SELECT id FROM "org_settings" WHERE "organizationId" = ${organizationId} FOR UPDATE`
      existing = await tx.orgSettings.findUniqueOrThrow({ where: { organizationId } })
    }
    if (existing?.onboardingV2Key === input.idempotencyKey) {
      return onboardingV2ConfirmationResultSchema.parse(existing.onboardingV2Result)
    }
    if (existing?.onboardingCompletedAt || ["complete", "completed"].includes(existing?.onboardingStatus ?? "")) {
      return { status: "already_complete" as const }
    }
    if (await hasIssuedDocuments(tx, organizationId)) {
      throw new TRPCError({ code: "CONFLICT", message: "Onboarding cannot reset settings after documents have been issued" })
    }
    // The provider owns durable provisioning retries if the following writes roll back.
    // A failed hook must leave the confirmation incomplete. Completed retries return above.
    await billingProvider.startTrial?.(organizationId)
    const completedAt = new Date()
    const result = { status: "complete" as const, version: 2 as const, completedAt: completedAt.toISOString(), bankMissing: !input.bank }
    const settings = {
      ...buildDkPresets(input, signupEmail),
      bankAccountHolder: input.bank ? input.companyName : null,
      bankName: null,
      bankRegNumber: input.bank?.regNumber ?? null,
      bankAccountNumber: input.bank?.accountNumber ?? null,
      bankIban: null,
      bankBic: null,
      onboardingStatus: "complete",
      onboardingMethod: input.source,
      onboardingVersion: 2,
      onboardingCompletedAt: completedAt,
      onboardingV2Key: input.idempotencyKey,
      onboardingV2Result: result,
    }
    await tx.organization.update({ where: { id: organizationId }, data: { name: input.companyName } })
    await tx.orgSettings.upsert({ where: { organizationId }, create: { organizationId, ...settings }, update: settings })
    // Replace only registration/VAT IDs; unrelated identifiers remain intact.
    await tx.organizationTaxId.updateMany({ where: { organizationId, isPrimary: true }, data: { isPrimary: false } })
    await tx.organizationTaxId.deleteMany({ where: { organizationId, OR: ["cvr", "vat", "dk_cvr", "dk_vat"].map(scheme => ({ scheme: { equals: scheme, mode: "insensitive" as const } })) } })
    await tx.organizationTaxId.createMany({ data: [
      { organizationId, scheme: "cvr", value: input.cvr, countryCode: "DK", isPrimary: true },
      ...(input.vatId ? [{ organizationId, scheme: "vat", value: input.vatId, countryCode: "DK", isPrimary: false }] : []),
    ] })
    if (input.catalogSuggestions.length) {
      await tx.catalogItem.createMany({ data: input.catalogSuggestions.map(item => ({
        organizationId, name: item.name, description: item.description ?? null, defaultUnitPrice: item.defaultUnitPrice,
      })) })
    }
    return result
  }, { timeout: 60_000 })
}
