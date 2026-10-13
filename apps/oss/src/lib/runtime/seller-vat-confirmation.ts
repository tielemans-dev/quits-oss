import { isReplacedDanishTaxId } from "../onboarding/danish-tax-id"
import { isNationalRegistrationScheme, nationalRegistrationForScheme } from "../compliance/registry"
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
  if (!getRuntimeCapabilities().sellerVatConfirmation?.enabled) return undefined
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
  const seller = { companyName: settings.companyName, companyAddress: settings.companyAddress, countryCode: settings.countryCode, taxIds: sellerConfirmationTaxIds(taxIds) }
  const identityChanged = input.previousSeller !== undefined && sellerConfirmationIdentity(input.previousSeller) !== sellerConfirmationIdentity(seller)
  const needsReconfirmation = settings.countryCode === "DK" && settings.taxRegime === "eu_vat" && (enteringDanishVat || identityChanged)
  // A choice confirmed for the previous identity or jurisdiction is not evidence for the new one.
  if (needsReconfirmation && input.registered === undefined) {
    if (settings.momsRegistered !== null) {
      await input.tx.orgSettings.update({ where: { organizationId: input.organizationId }, data: { momsRegistered: null } })
    }
    return
  }
  const registered = input.registered
  // Unknown status remains fail-closed at issuance. Same-identity saves retain confirmed status.
  if (registered === undefined) return
  // A jurisdiction/tax-regime transition retains general financial settings behavior.
  // It cannot create evidence for another identity or grant issuance permission.
  if (!input.token && (settings.countryCode !== "DK" || settings.taxRegime !== "eu_vat")) return
  if (!input.token) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose and confirm seller VAT status" })
  await service.confirm({ ...input, registered, token: input.token, seller })
}

/** Order the final public identity independently of row timestamps, primary flags and DB tie order.
 * Apply only after projecting writes: Settings must select its existing primary before sorting.
 */
export function sellerConfirmationTaxIds(taxIds: NonNullable<SellerSnapshot["taxIds"]>) {
  const key = (id: typeof taxIds[number]) => JSON.stringify([id.scheme, id.value, id.countryCode])
  return [...taxIds].sort((a, b) => {
    const left = key(a)
    const right = key(b)
    return left < right ? -1 : left > right ? 1 : 0
  })
}

/** Project the primary-ID write performed by settings.update, preserving the other IDs. */
export function settingsConfirmationTaxIds(
  orderedTaxIds: NonNullable<SellerSnapshot["taxIds"]>, value: string, scheme: string,
  registered?: boolean | null,
): NonNullable<SellerSnapshot["taxIds"]> {
  const registration = nationalRegistrationForScheme("cvr")!
  const nextScheme = scheme.trim() || "vat"
  const eligible = (id: typeof orderedTaxIds[number]) =>
    (!id.countryCode || id.countryCode === "DK") &&
    (isNationalRegistrationScheme(id.scheme, "DK") || ["vat", "dk_vat"].includes(id.scheme?.toLowerCase() ?? ""))
  const oldPrimary = orderedTaxIds[0]
  const primary = { ...oldPrimary, value: value.trim(), scheme: nextScheme, countryCode: "DK" }
  const oldCvr = oldPrimary ? registration.normalize(oldPrimary.value) : ""
  const nextCvr = registration.normalize(value)
  const refreshPair = oldPrimary && eligible(oldPrimary) && eligible(primary) && /^\d{8}$/.test(oldCvr) && /^\d{8}$/.test(nextCvr)
  const rest = orderedTaxIds.slice(1).map(id => refreshPair && (!id.countryCode || id.countryCode === "DK") &&
    ["vat", "dk_vat"].includes(id.scheme?.toLowerCase() ?? "") && id.value === `DK${oldCvr}`
      ? { ...id, value: `DK${nextCvr}` } : id)
  if (registered === false && ["vat", "dk_vat"].includes(nextScheme.toLowerCase()) && /^(DK)?\d{8}$/.test(value.replace(/[\s.\-/]/g, "").toUpperCase())) {
    primary.scheme = "cvr"
    primary.value = nextCvr
  }
  return [primary, ...rest]
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
  const retained = orderedTaxIds.filter(id => !isReplacedDanishTaxId({ scheme: id.scheme ?? "", value: id.value, countryCode: id.countryCode ?? null }))
  return [...registration.filter(id => id.scheme === "cvr"), ...retained, ...registration.filter(id => id.scheme === "vat")]
}
