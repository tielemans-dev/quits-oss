import { readAgreementOfferSnapshot } from "@quits/contracts/agreements"
import type { ClientActionCapability } from "@quits/contracts/client-actions"
import { computeSettlement } from "../../domain/documents/settlement"
import { prisma } from "../db"
import { publicLogoPath } from "../documents/public-logo"
import { resolvePublicPresentation, type PublicSeller } from "../documents/public-presentation"
import { publicAgreementDto, publicDeliverableDto } from "../agreements/public"
import { loadPublicInvoice } from "../payments/public-access"
import { serializePublicInvoiceSession } from "../payments/public-session"
import { grantCapabilities, type ActiveClientActionLink, type GrantRef } from "./access"
import { mintClientActionToken } from "./tokens"

/**
 * What a client action page shows, built from the link's grants and nothing else. The seller's
 * preview and the recipient's page both come from `buildClientActionPage`, so they cannot differ in
 * which records they show. Every record is read through its grant, scoped to the link's
 * organization and contact; an id the link was not granted cannot be asked for.
 *
 * Every item is an explicit allowlist: no internal notes, rates, evidence, IP addresses or other
 * records of the same customer.
 */

export type ClientActionItem =
  | {
      kind: "agreement"
      recordId: string
      locale: string
      number: string
      title: string
      /** `open`: awaiting a decision. The others are final or no longer actionable. */
      state: "open" | "accepted" | "declined" | "expired" | "closed"
      offerRevision: number
      expiresAt: string | null
      acceptedAt: string | null
      canApprove: boolean
      download: boolean
    }
  | {
      kind: "deliverable"
      recordId: string
      locale: string
      title: string
      agreementNumber: string
      agreementTitle: string
      state: "awaiting" | "accepted" | "changes_requested"
      deliveryRevision: number
      acceptedRevision: number | null
      deliveredAt: string | null
      canApprove: boolean
    }
  | {
      kind: "invoice"
      recordId: string
      locale: string
      number: string
      /** `payable`: something is owed and can be paid here. `open`: owed, but not payable here. */
      state: "payable" | "open" | "paid" | "credited"
      currency: string
      timezone: string
      totalGross: number
      amountPaid: number
      amountCredited: number
      balanceDue: number
      dueDate: string
      overdue: boolean
      canPay: boolean
      download: boolean
    }
  /**
   * A grant whose record can no longer be acted on, named only by its kind. `withdrawn`: the seller
   * revoked or re-issued the record's links. `unavailable`: the record is not in a state to show.
   */
  | { kind: "inactive"; recordKind: "agreement" | "deliverable" | "invoice"; recordId: string; state: "withdrawn" | "unavailable" }

export type ClientActionPage = {
  kind: "ready"
  locale: string
  timezone: string
  seller: PublicSeller
  recipientName: string
  expiresAt: string
  verification: { required: boolean; verified: boolean; emailHint: string | null }
  items: ClientActionItem[]
  /** Items waiting for the recipient: a decision, a sign-off or a payment. */
  attention: number
}

export function maskEmail(email: string | null) {
  if (!email) return null
  const [local, domain] = email.split("@")
  if (!local || !domain) return null
  return `${local.slice(0, 1)}${"•".repeat(Math.max(Math.min(local.length - 1, 5), 1))}@${domain}`
}

/** A grant is current when the record's link generation is the one granted. */
const current = (grant: GrantRef, keyVersion: number) => grant.keyVersion === keyVersion

export async function loadGrantedAgreement(link: ActiveClientActionLink, grant: GrantRef) {
  const agreement = await prisma.agreement.findFirst({
    where: { id: grant.recordId, organizationId: link.organizationId, contactId: link.contactId },
    include: { deliverables: { orderBy: { sortOrder: "asc" } } },
  })
  if (!agreement || !agreement.offerSnapshot) return { state: "unavailable" as const }
  if (!current(grant, agreement.publicAccessKeyVersion)) return { state: "withdrawn" as const }
  return { state: "ready" as const, agreement }
}

export async function loadGrantedDeliverable(link: ActiveClientActionLink, grant: GrantRef) {
  const line = await prisma.deliverable.findFirst({
    where: {
      id: grant.recordId,
      agreement: { organizationId: link.organizationId, contactId: link.contactId },
    },
    include: { agreement: true },
  })
  if (!line || !line.agreement.offerSnapshot) return { state: "unavailable" as const }
  if (!current(grant, line.agreement.publicAccessKeyVersion)) return { state: "withdrawn" as const }
  // Same preconditions as the delivery sign-off link: an accepted agreement and a delivered line.
  if (
    line.agreement.status !== "accepted" ||
    line.isDeposit ||
    !["delivered", "accepted", "changes_requested"].includes(line.status)
  )
    return { state: "unavailable" as const }
  return { state: "ready" as const, line, agreement: line.agreement }
}

export async function loadGrantedInvoice(link: ActiveClientActionLink, grant: GrantRef) {
  const session = await loadPublicInvoice({
    id: grant.recordId,
    keyVersion: grant.keyVersion,
    organizationId: link.organizationId,
    contactId: link.contactId,
  })
  if (!session) return { state: "unavailable" as const }
  return { state: "ready" as const, invoice: session.invoice, paymentState: session.paymentState, stripeEnabled: session.stripeEnabled }
}

function agreementItem(
  grant: GrantRef,
  agreement: NonNullable<Extract<Awaited<ReturnType<typeof loadGrantedAgreement>>, { state: "ready" }>["agreement"]>,
  capabilities: ClientActionCapability[],
  now: Date,
): ClientActionItem {
  const snapshot = readAgreementOfferSnapshot(agreement.offerSnapshot)
  const live = agreement.status === "sent" && agreement.expiresAt !== null && now < agreement.expiresAt
  const state: Extract<ClientActionItem, { kind: "agreement"; title: string }>["state"] =
    agreement.status === "accepted" || agreement.status === "completed"
      ? "accepted"
      : agreement.status === "declined"
        ? "declined"
        : agreement.status === "sent"
          ? live
            ? "open"
            : "expired"
          : "closed"
  return {
    kind: "agreement",
    recordId: grant.recordId,
    locale: snapshot.locale,
    number: agreement.number ?? "",
    title: snapshot.title,
    state,
    offerRevision: agreement.offerRevision,
    expiresAt: agreement.expiresAt?.toISOString() ?? null,
    acceptedAt: agreement.acceptedAt?.toISOString() ?? null,
    canApprove: capabilities.includes("approve"),
    download: Boolean(agreement.artifactPdfRef),
  }
}

export async function buildClientActionPage(
  link: ActiveClientActionLink,
  options: { token?: string; verified: boolean; now?: Date },
): Promise<ClientActionPage> {
  const now = options.now ?? new Date()
  const token = options.token ?? mintClientActionToken(link.id)
  const items: ClientActionItem[] = []
  for (const grant of link.grants) {
    const capabilities = grantCapabilities(grant)
    const kind = grant.recordKind as "agreement" | "deliverable" | "invoice"
    if (kind === "agreement") {
      const loaded = await loadGrantedAgreement(link, grant)
      items.push(
        loaded.state === "ready"
          ? agreementItem(grant, loaded.agreement, capabilities, now)
          : { kind: "inactive", recordKind: kind, recordId: grant.recordId, state: loaded.state },
      )
    } else if (kind === "deliverable") {
      const loaded = await loadGrantedDeliverable(link, grant)
      if (loaded.state !== "ready") {
        items.push({ kind: "inactive", recordKind: kind, recordId: grant.recordId, state: loaded.state })
        continue
      }
      const { line, agreement } = loaded
      items.push({
        kind,
        recordId: grant.recordId,
        locale: readAgreementOfferSnapshot(agreement.offerSnapshot).locale,
        title: line.title,
        agreementNumber: agreement.number ?? "",
        agreementTitle: agreement.title,
        state: line.status === "delivered" ? "awaiting" : (line.status as "accepted" | "changes_requested"),
        deliveryRevision: line.deliveryRevision,
        acceptedRevision: line.acceptedRevision,
        deliveredAt: line.deliveredAt?.toISOString() ?? null,
        canApprove: capabilities.includes("approve"),
      })
    } else if (kind === "invoice") {
      const loaded = await loadGrantedInvoice(link, grant)
      if (loaded.state !== "ready") {
        items.push({ kind: "inactive", recordKind: kind, recordId: grant.recordId, state: loaded.state })
        continue
      }
      const { invoice, paymentState, stripeEnabled } = loaded
      const settlement = computeSettlement(invoice)
      const credited = invoice.status === "credited"
      const canPay = capabilities.includes("pay")
      items.push({
        kind,
        recordId: grant.recordId,
        locale: invoice.locale,
        // An invoice with a public payment link has been issued, so it has its number.
        number: invoice.number ?? "",
        state: credited
          ? "credited"
          : paymentState === "paid"
            ? "paid"
            : canPay && stripeEnabled
              ? "payable"
              : "open",
        currency: invoice.currency,
        timezone: invoice.timezone,
        totalGross: invoice.totalGross.toNumber(),
        amountPaid: settlement.amountPaid.toNumber(),
        amountCredited: settlement.amountCredited.toNumber(),
        balanceDue: paymentState === "paid" ? 0 : settlement.balanceDue.toNumber(),
        dueDate: invoice.dueDate.toISOString(),
        overdue: invoice.status === "overdue",
        canPay,
        download: Boolean(invoice.artifactPdfRef),
      })
    }
  }

  const firstLocale = items.flatMap((item) => (item.kind === "inactive" ? [] : [item.locale]))[0]
  const presentation = resolvePublicPresentation({
    document: { locale: firstLocale },
    settings: link.organization.settings,
    logoPath: publicLogoPath("c", token),
  })
  const needsVerification =
    link.verification === "email_code" && link.grants.some((grant) => grantCapabilities(grant).includes("approve"))
  const attention = items.filter(
    (item) =>
      (item.kind === "agreement" && item.state === "open" && item.canApprove) ||
      (item.kind === "deliverable" && item.state === "awaiting" && item.canApprove) ||
      (item.kind === "invoice" && item.state === "payable"),
  ).length
  return {
    kind: "ready",
    locale: presentation.locale,
    timezone: presentation.timezone,
    seller: presentation.seller,
    recipientName: link.recipientName,
    expiresAt: link.expiresAt.toISOString(),
    verification: {
      required: needsVerification,
      verified: !needsVerification || options.verified,
      emailHint: needsVerification ? maskEmail(link.recipientEmail) : null,
    },
    items,
    attention,
  }
}

/** One record in full, for the detail view. Null when the link holds no `view` grant for it. */
export async function buildClientActionDetail(
  link: ActiveClientActionLink,
  ref: { kind: "agreement" | "deliverable" | "invoice"; recordId: string },
  token: string,
  now = new Date(),
) {
  const grant = link.grants.find((candidate) => candidate.recordKind === ref.kind && candidate.recordId === ref.recordId)
  if (!grant || !grantCapabilities(grant).includes("view")) return null
  const capabilities = grantCapabilities(grant)
  const logoPath = publicLogoPath("c", token)
  const settings = link.organization.settings
  if (ref.kind === "agreement") {
    const loaded = await loadGrantedAgreement(link, grant)
    if (loaded.state !== "ready") return null
    const { agreement } = loaded
    const snapshot = readAgreementOfferSnapshot(agreement.offerSnapshot)
    const presentation = resolvePublicPresentation({
      document: { locale: snapshot.locale, timezone: snapshot.timezone, sellerSnapshot: snapshot.sellerSnapshot },
      settings,
      logoPath,
    })
    const live = agreement.status === "sent" && agreement.expiresAt !== null && now < agreement.expiresAt
    return {
      kind: "agreement" as const,
      recordId: grant.recordId,
      locale: presentation.locale,
      document: publicAgreementDto(agreement),
      canDecide: live && capabilities.includes("approve"),
      download: Boolean(agreement.artifactPdfRef),
    }
  }
  if (ref.kind === "deliverable") {
    const loaded = await loadGrantedDeliverable(link, grant)
    if (loaded.state !== "ready") return null
    const snapshot = readAgreementOfferSnapshot(loaded.agreement.offerSnapshot)
    return {
      kind: "deliverable" as const,
      recordId: grant.recordId,
      locale: snapshot.locale,
      deliverable: publicDeliverableDto(loaded.agreement, loaded.line),
      canDecide: capabilities.includes("approve"),
    }
  }
  const loaded = await loadGrantedInvoice(link, grant)
  if (loaded.state !== "ready") return null
  const session = serializePublicInvoiceSession(
    { invoice: loaded.invoice, paymentState: loaded.paymentState, stripeEnabled: loaded.stripeEnabled && capabilities.includes("pay") },
    token,
    logoPath,
  )
  return {
    kind: "invoice" as const,
    recordId: grant.recordId,
    locale: session.locale,
    session,
    download: Boolean(loaded.invoice.artifactPdfRef),
  }
}
export type ClientActionDetail = NonNullable<Awaited<ReturnType<typeof buildClientActionDetail>>>
