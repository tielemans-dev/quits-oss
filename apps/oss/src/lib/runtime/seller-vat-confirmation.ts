import type { SellerSnapshot } from "@quits/contracts/documents"
import type { Prisma } from "../../../generated/prisma/client"
import { TRPCError } from "@trpc/server"
import { getRuntimeCapabilities, getRuntimeExtensions } from "./extensions"

/** The request is passed through only on the server. Credentials never enter capabilities. */
export type SellerVatConfirmationActor = {
  organizationId: string
  userId: string
  sessionId: string
  request?: { url: string; headers: Headers }
}
export type SellerVatConfirmationTransaction = Pick<Prisma.TransactionClient,
  "$queryRaw" | "$executeRaw" | "session" | "member" | "orgSettings" | "organizationTaxId">
export type SellerVatConfirmationService = {
  prepare(input: SellerVatConfirmationActor & { seller: SellerSnapshot }): Promise<{ token: string }>
  confirm(input: SellerVatConfirmationActor & {
    tx: SellerVatConfirmationTransaction
    seller: SellerSnapshot
    registered: boolean | null
    token: string
  }): Promise<void>
}

export function getSellerVatConfirmationService() {
  if (!getRuntimeCapabilities().sellerVatConfirmation.enabled) return undefined
  const providers = getRuntimeExtensions().flatMap(extension => extension.sellerVatConfirmation ? [extension.sellerVatConfirmation] : [])
  if (providers.length !== 1) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Seller VAT confirmation is unavailable" })
  return providers[0]!
}

/** Runs in the settings transaction, after final identity writes, under the issuance lock. */
export async function confirmSellerVatStatus(input: SellerVatConfirmationActor & {
  tx: SellerVatConfirmationTransaction
  registered?: boolean | null
  token?: string
  previousSettings?: { countryCode: string; taxRegime: string } | null
  previousSeller?: SellerSnapshot | null
}) {
  const service = getSellerVatConfirmationService()
  if (!service) {
    if (input.token) throw new TRPCError({ code: "FORBIDDEN", message: "Seller VAT confirmation is disabled" })
    return
  }
  const settings = await input.tx.orgSettings.findUniqueOrThrow({ where: { organizationId: input.organizationId } })
  const enteringDanishVat = input.previousSettings !== undefined &&
    settings.countryCode === "DK" && settings.taxRegime === "eu_vat" &&
    (input.previousSettings?.countryCode !== "DK" || input.previousSettings?.taxRegime !== "eu_vat")
  const taxIds = await input.tx.organizationTaxId.findMany({ where: { organizationId: input.organizationId }, orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }], select: { scheme: true, value: true, countryCode: true } })
  const seller = { companyName: settings.companyName, companyAddress: settings.companyAddress, countryCode: settings.countryCode, taxIds }
  const identityChanged = input.previousSeller !== undefined && sellerConfirmationIdentity(input.previousSeller) !== sellerConfirmationIdentity(seller)
  const needsReconfirmation = settings.countryCode === "DK" && settings.taxRegime === "eu_vat" && (enteringDanishVat || identityChanged)
  const registered = input.registered === undefined && needsReconfirmation ? settings.momsRegistered : input.registered
  // Unknown status remains fail-closed at issuance. Same-identity saves retain confirmed status.
  if (registered === undefined || (input.registered === undefined && registered === null)) return
  // A jurisdiction/tax-regime transition retains general financial settings behavior.
  // It cannot create evidence for another identity or grant issuance permission.
  if (!input.token && (settings.countryCode !== "DK" || settings.taxRegime !== "eu_vat")) return
  if (!input.token) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose and confirm seller VAT status" })
  await service.confirm({ ...input, registered, token: input.token, seller })
}

/** Project the primary-ID write performed by settings.update, preserving the other IDs. */
export function settingsConfirmationTaxIds(
  orderedTaxIds: NonNullable<SellerSnapshot["taxIds"]>, value: string, scheme: string,
): NonNullable<SellerSnapshot["taxIds"]> {
  const primary = { ...orderedTaxIds[0], value: value.trim(), scheme: scheme.trim() || "vat" }
  // New settings IDs have no countryCode, matching the database's nullable default.
  return orderedTaxIds.length ? [primary, ...orderedTaxIds.slice(1)] : [{ ...primary, countryCode: null }]
}

/** Compare only token-bound stored fields. Tax-ID row order and database metadata are immaterial. */
function sellerConfirmationIdentity(seller: SellerSnapshot | null) {
  return JSON.stringify([seller?.companyName ?? null, seller?.companyAddress ?? null, seller?.countryCode ?? null,
    (seller?.taxIds ?? []).map(id => JSON.stringify([id.scheme ?? null, id.value, id.countryCode ?? null])).sort()])
}

/** The registration IDs written by onboarding, with the same representation and order. */
export function onboardingRegistrationTaxIds(cvr: string, vatId?: string) {
  return [
    ...(cvr ? [{ scheme: "cvr", value: cvr, countryCode: "DK" }] : []),
    ...(vatId ? [{ scheme: "vat", value: vatId, countryCode: "DK" }] : []),
  ]
}

/** Onboarding replaces registration IDs and demotes retained IDs before adding its new CVR. */
export function onboardingConfirmationTaxIds(orderedTaxIds: NonNullable<SellerSnapshot["taxIds"]>, cvr: string, vatId?: string) {
  const registration = onboardingRegistrationTaxIds(cvr, vatId)
  const retained = orderedTaxIds.filter(id => !["cvr", "vat", "dk_cvr", "dk_vat"].includes(id.scheme?.toLowerCase() ?? ""))
  return [...registration.filter(id => id.scheme === "cvr"), ...retained, ...registration.filter(id => id.scheme === "vat")]
}
