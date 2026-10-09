import { Effect } from "effect"
import { z } from "zod"
import { documentViewSchema, documentViewDateSchema, type DocumentKind, type DocumentView } from "@quits/contracts/document-view"
import { parseBuyerSnapshot, parseSellerSnapshot } from "@quits/contracts/documents"
import { draftVatEvidenceSchema } from "@quits/contracts/vat"
import { requireCurrencyExponent } from "@quits/shared/currency"
import { buildDraftView, buildIssuedView, type DraftViewInput, type IssuedMoneySnapshot } from "@quits/shared/documents"
import { percentageToFraction } from "@quits/shared/pricing"
import type { Invoice, InvoiceItem, OrgSettings } from "../../../generated/prisma/client"
import { prisma } from "../../lib/db"
import { formatIsoDate } from "../../lib/exports/format"
import { actorCan, type Actor } from "../actor"
import { Command, Db } from "../services"
import { peekNextDocumentNumber } from "./numbering"
import { impliedTaxRate } from "./pricing"

type Row = Pick<InvoiceItem,
  "id" | "description" | "quantity" | "quantityInput" | "unitPriceInput" | "unitPriceNet" | "unitPriceGross" |
  "vatTreatment" | "vatRateInput" | "taxRate" | "vatCountry" | "vatReasonCode" | "lineNet" | "lineTax" | "lineGross"
> & { deliverableId?: string | null; clientKey?: string | null }
type DocumentRows = Pick<Invoice,
  "status" | "number" | "locale" | "timezone" | "currency" | "pricesIncludeTax" | "calculationVersion" |
  "sellerSnapshot" | "buyerSnapshot" | "vatEvidence" | "contactId" | "notes" | "issueDate" |
  "subtotalNet" | "totalTax" | "totalGross"
> & {
  items: Row[]
  supplyDate?: Date | null
  dueDate?: Date | null
  expiryDate?: Date | null
  paymentReference?: string | null
}
type Branding = Pick<OrgSettings, "companyPhone" | "companyLogo">

/** The only database-row adapter for draft views. Loading never reprices persisted lines. */
export function draftViewInputFromRows(
  kind: "invoice" | "quote", document: DocumentRows,
  options: { branding?: Branding | null; previewNumber?: string | null; lockAll?: boolean } = {}
): DraftViewInput {
  const exponent = requireCurrencyExponent(document.currency)
  const evidence = draftVatEvidenceSchema.safeParse(document.vatEvidence ?? {})
  return {
    kind, status: document.status, locale: document.locale, timezone: document.timezone,
    currency: document.currency, pricesIncludeTax: document.pricesIncludeTax,
    calculationVersion: document.calculationVersion === "v2" ? "v2" : "legacy_per_line",
    taxRate: impliedTaxRate(document),
    number: document.number, previewNumber: options.previewNumber,
    seller: parseSellerSnapshot(document.sellerSnapshot), buyer: parseBuyerSnapshot(document.buyerSnapshot),
    sellerPhone: options.branding?.companyPhone, logoUrl: options.branding?.companyLogo,
    contactId: document.contactId, notes: document.notes, paymentReference: document.paymentReference,
    vatEvidence: evidence.success ? evidence.data : null,
    dates: {
      issueDate: document.status === "draft" ? null : formatIsoDate(document.issueDate, document.timezone),
      supplyDate: document.supplyDate?.toISOString().slice(0, 10) ?? null,
      dueDate: document.dueDate?.toISOString().slice(0, 10) ?? null,
      expiryDate: document.expiryDate?.toISOString().slice(0, 10) ?? null,
    },
    lines: document.items.map(line => ({
      id: line.id, clientKey: line.clientKey || line.id, description: line.description,
      quantity: line.quantityInput ?? line.quantity.toFixed(),
      unitPrice: line.unitPriceInput ?? (document.pricesIncludeTax ? line.unitPriceGross : line.unitPriceNet).toFixed(),
      vat: {
        treatment: line.vatTreatment as NonNullable<DraftViewInput["lines"][number]["vat"]>["treatment"],
        rate: line.vatRateInput ?? percentageToFraction(line.taxRate.toFixed()),
        country: line.vatCountry,
        reasonCode: line.vatReasonCode as NonNullable<DraftViewInput["lines"][number]["vat"]>["reasonCode"],
      },
      stored: { net: line.lineNet.toFixed(exponent), tax: line.lineTax.toFixed(exponent), gross: line.lineGross.toFixed(exponent) },
      locked: options.lockAll === true || Boolean(line.deliverableId),
    })),
  }
}

/** JSON may be sparse or corrupt, including nested fields which make the pure builder throw. */
function snapshotView(snapshot: unknown, extras: Parameters<typeof buildIssuedView>[1]): DocumentView | null {
  try {
    const parsed = documentViewSchema.safeParse(buildIssuedView(snapshot as IssuedMoneySnapshot, extras))
    return parsed.success ? parsed.data : null
  } catch {
    // Includes DocumentSnapshotIncomplete, invalid decimal inputs and malformed nested objects.
    // Keep this boundary around snapshot construction only; database failures must still propagate.
    return null
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Only the corrected invoice's frozen calendar date is authoritative. */
function correctedIssueDate(snapshot: unknown) {
  const parsed = documentViewDateSchema.safeParse(record(snapshot).issueDate)
  return parsed.success ? parsed.data : null
}

/** Rows are the historical source when no readable money snapshot exists. Never reprice them. */
function issuedRowsView(kind: DocumentKind, document: DocumentRows, branding: Branding | null): DocumentView {
  const input = draftViewInputFromRows(kind === "quote" ? "quote" : "invoice", document, { branding, lockAll: true })
  const view = buildDraftView(input)
  const exponent = view.exponent
  // Some old rows have an incomplete classification. Their stored amounts remain authoritative.
  const rows = new Map(document.items.map(line => [line.id, line]))
  return {
    ...view, kind, state: "issued", number: { value: document.number, preview: null },
    calculation: { ...view.calculation, staleLegacy: false },
    paymentDetails: kind === "creditNote" ? null : view.paymentDetails,
    lines: view.lines.map(line => {
      const stored = rows.get(line.id!)!
      return { ...line, net: stored.lineNet.toFixed(exponent), tax: stored.lineTax.toFixed(exponent),
        gross: stored.lineGross.toFixed(exponent), amount: (document.pricesIncludeTax ? stored.lineGross : stored.lineNet).toFixed(exponent) }
    }),
    totals: {
      net: document.subtotalNet.toFixed(exponent), tax: document.totalTax.toFixed(exponent),
      gross: document.totalGross.toFixed(exponent), payable: document.totalGross.toFixed(exponent),
      payableRounding: document.totalGross.minus(document.subtotalNet).minus(document.totalTax).toFixed(exponent),
    },
  }
}

const frozenBrandingSchema = z.object({ pdf: z.object({ org: z.object({
  companyPhone: z.string().nullable().optional(), companyLogo: z.string().nullable().optional(),
}) }) })

export type DocumentViewResult = {
  view: DocumentView
  revision: number
  canEdit: boolean
  locks: { agreementLinked: boolean; emailSending: boolean }
  /** Show a historical-document notice: money came from rows because the issued snapshot was unreadable. */
  historical: boolean
  /** Unreadable row evidence was omitted; the stored evidence remains untouched. */
  notices: Array<"invalid_vat_evidence">
}

/** One consistent database read, scoped to the authenticated actor's organization throughout. */
export async function loadDocumentView(actor: Actor, kind: DocumentKind, id: string): Promise<DocumentViewResult | null> {
  const organizationId = actor.organizationId
  return prisma.$transaction(async db => {
    const include = { items: { orderBy: { sortOrder: "asc" as const } } }
    const document = kind === "invoice"
      ? await db.invoice.findFirst({ where: { id, organizationId }, include })
      : kind === "quote"
        ? await db.quote.findFirst({ where: { id, organizationId }, include })
        : await db.creditNote.findFirst({ where: { id, organizationId }, include })
    if (!document) return null
    const isDraft = kind !== "creditNote" && document.status === "draft"
    const settings = await db.orgSettings.findUnique({ where: { organizationId }, select: { companyPhone: true, companyLogo: true } })
    let branding = settings
    if (!isDraft && kind !== "quote") {
      // Only a published candidate can supply issued branding. A failed re-email must not replace it.
      const candidate = await db.issuanceCandidate.findFirst({
        where: { organizationId, documentKind: kind, documentId: id, status: "published" },
        orderBy: { createdAt: "asc" }, select: { renderInput: true },
      })
      const frozen = frozenBrandingSchema.safeParse(candidate?.renderInput)
      // Do not invent historical branding from today's settings when it was never frozen.
      branding = frozen.success ? { companyPhone: frozen.data.pdf.org.companyPhone ?? null, companyLogo: frozen.data.pdf.org.companyLogo ?? null } : null
    }
    const previewNumber = isDraft ? await Effect.runPromise(peekNextDocumentNumber(kind).pipe(
      Effect.provideService(Db, db),
      Effect.provideService(Command, { actor, organizationId, commandId: "document-view", now: new Date(), approvedByUserId: null, emit: () => {}, enqueue: () => {} })
    )) : null
    const corrected = kind === "creditNote" && "invoiceId" in document
      ? await db.invoice.findFirst({ where: { id: document.invoiceId, organizationId }, select: { number: true, issuanceSnapshot: true } }) : null
    const correctionDate = correctedIssueDate(corrected?.issuanceSnapshot)
    let view = isDraft ? buildDraftView(draftViewInputFromRows(kind === "quote" ? "quote" : "invoice", document, { branding, previewNumber })) : null
    let historical = false
    if (!isDraft && kind !== "quote") {
      view = snapshotView("issuanceSnapshot" in document ? document.issuanceSnapshot : null, {
        kind, status: document.status, locale: document.locale, timezone: document.timezone,
        sellerPhone: branding?.companyPhone, logoUrl: branding?.companyLogo, contactId: document.contactId,
        notes: document.notes, paymentReference: "paymentReference" in document ? document.paymentReference : null,
        correctsIssueDate: correctionDate,
      })
      historical = view === null
    }
    // Quotes deliberately use locked stored rows after draft; they have no issuanceSnapshot.
    if (!view) view = issuedRowsView(kind, document, branding)
    if (kind === "creditNote" && historical && corrected?.number && "reason" in document) {
      view.correction = { invoiceNumber: corrected.number, invoiceIssueDate: correctionDate, reason: document.reason }
    }
    const emailSending = document.lastEmailAttemptOutcome === "sending"
    return {
      view, historical,
      notices: (isDraft || kind === "quote" || historical) && !draftVatEvidenceSchema.safeParse(document.vatEvidence ?? {}).success ? ["invalid_vat_evidence"] : [],
      revision: "editRevision" in document ? document.editRevision : 0,
      canEdit: isDraft && !emailSending && actorCan(actor, kind === "quote" ? "quote:update" : "invoice:update"),
      locks: { agreementLinked: "agreementId" in document && Boolean(document.agreementId), emailSending },
    }
  }, { isolationLevel: "RepeatableRead" })
}
