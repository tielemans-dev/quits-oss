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
}) {
  const service = getSellerVatConfirmationService()
  if (!service) {
    if (input.token) throw new TRPCError({ code: "FORBIDDEN", message: "Seller VAT confirmation is disabled" })
    return
  }
  if (input.registered === undefined) return
  if (!input.token) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose and confirm seller VAT status" })
  const settings = await input.tx.orgSettings.findUniqueOrThrow({ where: { organizationId: input.organizationId } })
  const taxIds = await input.tx.organizationTaxId.findMany({ where: { organizationId: input.organizationId } })
  await service.confirm({ ...input, registered: input.registered, token: input.token,
    seller: { companyName: settings.companyName, companyAddress: settings.companyAddress, countryCode: settings.countryCode, taxIds } })
}
