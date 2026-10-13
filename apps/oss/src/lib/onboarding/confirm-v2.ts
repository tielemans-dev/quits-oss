import { onboardingRegistrationTaxIds, confirmSellerVatStatus, getSellerVatConfirmationService, type SellerVatConfirmationActor } from "../runtime/seller-vat-confirmation"
import { TRPCError } from "@trpc/server"
import { onboardingV2ConfirmationResultSchema, type ConfirmOnboardingV2 } from "@quits/contracts/onboarding"
import { billingProvider } from "../billing"
import { isNonVatRegistrationAllowed } from "../runtime/extensions"
import { prisma } from "../db"
import { buildDkPresets } from "./dk-presets"
import { hasIssuedDocuments } from "../../domain/documents/base-currency"

/** One final save. The organization lock also serializes confirms before a settings row exists. */
export async function confirmOnboardingV2(organizationId: string, input: ConfirmOnboardingV2, signupEmail: string, actor?: SellerVatConfirmationActor) {
  const sellerVatConfirmation = getSellerVatConfirmationService()
  if (sellerVatConfirmation && !actor) throw new TRPCError({ code: "FORBIDDEN", message: "Seller VAT confirmation requires an authenticated actor" })
  // Hosted confirmation must present a token before any settings, identity, or trial write.
  if (actor && sellerVatConfirmation && !input.sellerVatConfirmationToken) throw new TRPCError({ code: "BAD_REQUEST", message: "save.failed" })
  // Client-supplied protection metadata cannot attest to a trusted registry lookup.
  // Until a server lookup supplies that trust, scrub all registry-sourced contacts.
  input = { ...input, reklamebeskyttet: input.source === "cvr" || input.reklamebeskyttet === true }
  // Lifecycle hooks can make several bounded provider requests. Allow their total latency
  // without changing the provider's individual request deadlines.
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "organization" WHERE id = ${organizationId} FOR NO KEY UPDATE`
    // Match the settings lock used by document issuance before checking/resetting its counters.
    await tx.$queryRaw`SELECT id FROM "org_settings" WHERE "organizationId" = ${organizationId} FOR UPDATE`
    let existing = await tx.orgSettings.findUnique({ where: { organizationId } })
    // Use one set of defaults for the whole confirmation, even across midnight.
    const presets = {
      ...buildDkPresets(input, signupEmail),
      ...input.settings,
      ...(input.settings ? { currency: input.settings.defaultCurrency, baseCurrency: input.settings.defaultCurrency } : {}),
      taxRate: input.momsRegistered ? input.settings?.taxRate ?? 25 : 0,
    }
    if (!existing) {
      // Insert inside confirm, then lock before checking issued documents. Another writer may
      // have created settings after the first read, so re-read under the same issuance lock.
      await tx.orgSettings.upsert({ where: { organizationId }, create: { organizationId, ...presets }, update: {} })
      await tx.$queryRaw`SELECT id FROM "org_settings" WHERE "organizationId" = ${organizationId} FOR UPDATE`
      existing = await tx.orgSettings.findUniqueOrThrow({ where: { organizationId } })
    }
    if (existing?.onboardingV2Key === input.idempotencyKey) {
      return onboardingV2ConfirmationResultSchema.parse(existing.onboardingV2Result)
    }
    if (existing?.onboardingCompletedAt || ["complete", "completed"].includes(existing?.onboardingStatus ?? "")) {
      return { status: "already_complete" as const }
    }
    if (!input.momsRegistered && !isNonVatRegistrationAllowed()) {
      throw new TRPCError({ code: "FORBIDDEN", message: "save.failed" })
    }
    // Pre-issuance-numbering migrations deliberately retain numbered drafts.
    const numberedDrafts = await tx.invoice.count({ where: { organizationId, status: "draft", number: { not: null } } }) +
      await tx.quote.count({ where: { organizationId, status: "draft", number: { not: null } } })
    if (numberedDrafts > 0 || await hasIssuedDocuments(tx, organizationId)) {
      throw new TRPCError({ code: "CONFLICT", message: "save.failed" })
    }
    const completedAt = new Date()
    const result = {
      status: "complete" as const, version: 2 as const, completedAt: completedAt.toISOString(),
      bankMissing: !input.bank && !existing.bankRegNumber && !existing.bankAccountNumber && !existing.bankIban,
    }
    const settings = {
      ...presets,
      // Preserve the book re-read under the lock, including a concurrently created row.
      invoicePrefix: existing.invoicePrefix,
      invoiceNextNum: Math.max(existing.invoiceNextNum, input.invoiceNextNum),
      quotePrefix: existing.quotePrefix,
      quoteNextNum: existing.quoteNextNum,
      // An omitted bank input is not a clear. Submitted details still replace the stored ones.
      ...(input.bank ? {
        bankAccountHolder: input.companyName,
        bankName: null,
        bankRegNumber: input.bank.regNumber,
        bankAccountNumber: input.bank.accountNumber,
        bankIban: null,
        bankBic: null,
      } : {}),
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
    await tx.organizationTaxId.createMany({ data: onboardingRegistrationTaxIds(input.cvr, input.vatId)
      .map(id => ({ ...id, organizationId, isPrimary: id.scheme === "cvr" })) })
    if (actor) await confirmSellerVatStatus({ ...actor, tx, registered: input.momsRegistered, token: input.sellerVatConfirmationToken })
    if (input.catalogSuggestions.length) {
      await tx.catalogItem.createMany({ data: input.catalogSuggestions.map(item => ({
        organizationId, name: item.name, description: item.description ?? null, defaultUnitPrice: item.defaultUnitPrice,
      })) })
    }
    // Confirmation and catalog writes are done. A failed hook still rolls the transaction back.
    await billingProvider.startTrial?.(organizationId)
    return result
  }, { timeout: 60_000 })
}
