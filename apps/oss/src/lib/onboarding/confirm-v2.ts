import { isReplacedDanishTaxId } from "./danish-tax-id"
import { confirmSellerVatStatus, getSellerVatConfirmationService, type SellerVatConfirmationActor } from "../runtime/seller-vat-confirmation"
import { TRPCError } from "@trpc/server"
import { onboardingV2ConfirmationResultSchema, type ConfirmOnboardingV2 } from "@quits/contracts/onboarding"
import { billingProvider } from "../billing"
import { isNonVatRegistrationAllowed } from "../runtime/extensions"
import { prisma } from "../db"
import { getCvrLookupProvider } from "../runtime/services"
import { buildDkPresets } from "./dk-presets"
import { hasIssuedDocuments } from "../../domain/documents/base-currency"
import { organizationSlugCandidate } from "../organization-slug"

/**
 * Onboarding creates the organization from a typed name before the CVR review. A slug still
 * derived from that name (`base` or `base-N`, as organization creation picks them) follows the
 * confirmed company name; a chosen slug stays. Best effort: nothing links to the slug before
 * onboarding completes, and failing to rename keeps the old slug.
 */
async function followConfirmedNameSlug(organizationId: string, previous: { name: string; slug: string }, companyName: string) {
  const derivedFrom = (name: string, slug: string) => {
    const suffix = /-([1-9]\d*)$/.exec(slug)
    return slug === organizationSlugCandidate(name, 1n) || (suffix !== null && BigInt(suffix[1]!) >= 2n && organizationSlugCandidate(name, BigInt(suffix[1]!)) === slug)
  }
  if (!derivedFrom(previous.name, previous.slug) || derivedFrom(companyName, previous.slug)) return
  // Same order as organization creation, checked in bounded batches of exact candidates.
  const batch = 50n
  for (let first = 1n; ; first += batch) {
    const candidates = Array.from({ length: Number(batch) }, (_, i) => organizationSlugCandidate(companyName, first + BigInt(i)))
    const taken = new Set((await prisma.organization.findMany({ where: { slug: { in: candidates } }, select: { slug: true } })).map(org => org.slug))
    for (const slug of candidates.filter(candidate => !taken.has(candidate))) {
      try {
        await prisma.organization.updateMany({ where: { id: organizationId, slug: previous.slug }, data: { slug } })
        return
      } catch (error) {
        // Taken meanwhile: try the next candidate. Any other failure keeps the old slug.
        if ((error as { code?: string } | null)?.code !== "P2002") return
      }
    }
  }
}

/**
 * Registry-sourced contacts are kept only when the server's own CVR lookup says the company is not
 * advertising-protected (reklamebeskyttet). No provider, a failed lookup or protection scrubs them.
 */
async function registryContactsAllowed(organizationId: string, input: ConfirmOnboardingV2, userId?: string) {
  if (input.source !== "cvr") return input.reklamebeskyttet !== true
  const provider = getCvrLookupProvider()
  if (!provider || !userId || (!input.companyEmail && !input.companyPhone)) return false
  try {
    const company = await provider.get(input.cvr, { userId, organizationId, signal: AbortSignal.timeout(10_000) })
    return company?.cvr === input.cvr && company.advertisingProtected === false
  } catch {
    return false
  }
}

/** One final save. The organization lock also serializes confirms before a settings row exists. */
export async function confirmOnboardingV2(organizationId: string, input: ConfirmOnboardingV2, signupEmail: string, actor?: SellerVatConfirmationActor) {
  const sellerVatConfirmation = getSellerVatConfirmationService()
  if (sellerVatConfirmation && !actor) throw new TRPCError({ code: "FORBIDDEN", message: "Seller VAT confirmation requires an authenticated actor" })
  // Hosted confirmation must present a token before any settings, identity, or trial write.
  if (actor && sellerVatConfirmation && !input.sellerVatConfirmationToken) throw new TRPCError({ code: "BAD_REQUEST", message: "save.failed" })
  // Client-supplied protection metadata cannot attest to a trusted registry lookup.
  input = { ...input, reklamebeskyttet: !(await registryContactsAllowed(organizationId, input, actor?.userId)) }
  // Lifecycle hooks can make several bounded provider requests. Allow their total latency
  // without changing the provider's individual request deadlines.
  let renamed = null as { name: string; slug: string } | null
  const result = await prisma.$transaction(async tx => {
    const [before] = await tx.$queryRaw<{ name: string; slug: string }[]>`SELECT name, slug FROM "organization" WHERE id = ${organizationId} FOR NO KEY UPDATE`
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
    renamed = before ?? null
    await tx.organization.update({ where: { id: organizationId }, data: { name: input.companyName } })
    await tx.orgSettings.upsert({ where: { organizationId }, create: { organizationId, ...settings }, update: settings })
    // Identify Danish rows before replacing the pair. Countryless foreign VAT IDs
    // can come from legacy Settings writes and must survive confirmation.
    const taxIds = await tx.organizationTaxId.findMany({
      where: { organizationId }, select: { id: true, scheme: true, value: true, countryCode: true },
    })
    const danishIds = taxIds.filter(isReplacedDanishTaxId).map(id => id.id)
    await tx.organizationTaxId.updateMany({ where: { organizationId, isPrimary: true }, data: { isPrimary: false } })
    await tx.organizationTaxId.deleteMany({ where: { organizationId, id: { in: danishIds } } })
    await tx.organizationTaxId.createMany({ data: [
      ...(input.cvr ? [{ organizationId, scheme: "cvr", value: input.cvr, countryCode: "DK", isPrimary: true }] : []),
      ...(input.vatId ? [{ organizationId, scheme: "vat", value: input.vatId, countryCode: "DK", isPrimary: false }] : []),
    ] })
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
  if (renamed) await followConfirmedNameSlug(organizationId, renamed, input.companyName).catch(() => {})
  return result
}
