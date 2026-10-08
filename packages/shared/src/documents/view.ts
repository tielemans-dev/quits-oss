import Decimal from "decimal.js-light"
import { documentViewDateSchema } from "@quits/contracts/document-view"
import type {
  DocumentKind, DocumentView, DocumentViewBankAccount, DocumentViewBuyer, DocumentViewCorrection, DocumentViewLine,
  DocumentViewLineVat, DocumentViewPaymentDetails, DocumentViewSeller, DocumentViewTaxId, DocumentViewVatGroup, PublicDocumentView,
} from "@quits/contracts/document-view"
import type { BuyerSnapshot, DocumentTaxId, SellerSnapshot } from "@quits/contracts/documents"
import type { DocumentLineInput } from "@quits/contracts/invoices"
import { hasBankAccount, hasPaymentDetails } from "@quits/contracts/payment-details"
import { decimalStringSchema, draftVatClassificationSchema, nonnegativeDecimalStringSchema } from "@quits/contracts/vat"
import type { DraftVatEvidence, VatEvidence, VatReasonCode, VatTreatment } from "@quits/contracts/vat"
import { requireCurrencyExponent } from "../currency"
import { documentVat, previewDraft, vatGroupKey } from "../pricing"

// Isolated from callers' Decimal configuration, like the pricing engine.
const D = Decimal.clone({ precision: 1024, rounding: Decimal.ROUND_HALF_UP })

/** `INV-0042`. The number a document would receive; also used by the client to preview the next one. */
export function formatDocumentNumber(prefix: string, value: number) {
  return `${prefix}-${String(value).padStart(4, "0")}`
}

/** Fixed to the currency's exponent, and never "-0.00". */
const fixed = (value: Decimal, exponent: number) => value.isZero() ? new D(0).toFixed(exponent) : value.toFixed(exponent)
const sum = (values: Decimal[]) => values.reduce((total, value) => total.plus(value), new D(0))
const byKey = (a: { key: string }, b: { key: string }) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0

/** A quantity or price as the user typed it. A number that is not finite is left empty, so it never calculates. */
const asEntered = (value: string | number) => typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : value

/** "0.250" and "0.25" are one rate. A rate that is not a number stays as it was entered. */
function canonicalRate(rate: string) {
  try { return new D(rate).toFixed() } catch { return rate }
}

/** A real calendar date as "YYYY-MM-DD", or null: a half-typed date, or 2026-02-30, is not a date. */
const calendarDate = (value: string | null | undefined) => value && documentViewDateSchema.safeParse(value).success ? value : null

/** Empty evidence says nothing, so it is null. */
function evidenceView<T extends DraftVatEvidence | VatEvidence>(evidence: T | null | undefined): T | null {
  return evidence && Object.values(evidence).some((value) => value !== undefined) ? evidence : null
}

/**
 * Keys must be unique within a document or rows would collide. A repeated key gets a suffix, in order,
 * so the same lines always get the same keys.
 */
function uniqueKeys(keys: string[]): string[] {
  const taken = new Set<string>()
  return keys.map((key) => {
    let candidate = key
    for (let n = 2; taken.has(candidate); n++) candidate = `${key}~${n}`
    taken.add(candidate)
    return candidate
  })
}

/**
 * The unit price excluding VAT. On a tax-exclusive document that is the price as entered, unrounded:
 * it is the legal unit price. On a tax-inclusive one it is the entered price taken out of the line's
 * VAT, `unitPrice / (1 + rate)`, rounded half-up to the entered price's decimals (at least two).
 * It does not depend on the quantity. Null when the price or the rate cannot be read.
 */
function unitPriceNetOf(pricesIncludeTax: boolean, unitPrice: string, rate: string): string | null {
  if (!decimalStringSchema.safeParse(unitPrice).success) return null
  if (!pricesIncludeTax) return unitPrice
  if (!nonnegativeDecimalStringSchema.safeParse(rate).success) return null
  const places = Math.max(2, unitPrice.split(".")[1]?.length ?? 0)
  return new D(unitPrice).div(new D(rate).plus(1)).toDecimalPlaces(places, D.ROUND_HALF_UP).toFixed(places)
}

function taxIdsView(taxIds: readonly DocumentTaxId[] | undefined): DocumentViewTaxId[] {
  return (taxIds ?? []).map((taxId) => ({ scheme: taxId.scheme ?? null, value: taxId.value, countryCode: taxId.countryCode ?? null }))
}

function sellerView(seller: SellerSnapshot | null | undefined, phone: string | null | undefined, logoUrl: string | null | undefined): DocumentViewSeller {
  return {
    name: seller?.companyName ?? null,
    email: seller?.companyEmail ?? null,
    phone: phone ?? null,
    address: seller?.companyAddress ?? null,
    logoUrl: logoUrl ?? null,
    taxIds: taxIdsView(seller?.taxIds),
  }
}

function buyerView(buyer: BuyerSnapshot | null | undefined, contactId: string | null | undefined): DocumentViewBuyer | null {
  if (!buyer) return null
  return {
    name: buyer.name ?? null, email: buyer.email ?? null, company: buyer.company ?? null, address: buyer.address ?? null,
    city: buyer.city ?? null, state: buyer.state ?? null, zip: buyer.zip ?? null, country: buyer.country ?? null,
    taxIds: taxIdsView(buyer.taxIds), contactId: contactId ?? null,
  }
}

/** Printed only on invoices (quotes, credit notes and agreements take no payments), and only when the seller has an account or a note. */
function paymentDetailsView(
  seller: SellerSnapshot | null | undefined, reference: string | null, kind: DocumentKind
): DocumentViewPaymentDetails | null {
  const account = seller?.bankAccount ?? null
  const note = seller?.paymentNote?.trim() ? seller.paymentNote : null
  if (kind !== "invoice" || !hasPaymentDetails({ bankAccount: account, note })) return null
  const bankAccount: DocumentViewBankAccount | null = account && hasBankAccount(account) ? {
    accountHolder: account.accountHolder ?? null, bankName: account.bankName ?? null,
    regNumber: account.regNumber ?? null, accountNumber: account.accountNumber ?? null,
    iban: account.iban ?? null, bic: account.bic ?? null,
  } : null
  return { bankAccount, note, reference }
}

function notesView(notes: string | null | undefined) {
  return notes?.trim() ? notes : null
}

const lineVat = (vat: { treatment: VatTreatment; rate: string; reasonCode: VatReasonCode | null; country: string | null }): DocumentViewLineVat =>
  ({ treatment: vat.treatment, rate: canonicalRate(vat.rate), reasonCode: vat.reasonCode, country: vat.country })

function lineAmounts(unitPrice: string, rate: string, net: Decimal, tax: Decimal, gross: Decimal, pricesIncludeTax: boolean, exponent: number) {
  const amounts = { net: fixed(net, exponent), tax: fixed(tax, exponent), gross: fixed(gross, exponent) }
  return { ...amounts, unitPriceNet: unitPriceNetOf(pricesIncludeTax, unitPrice, rate), amount: pricesIncludeTax ? amounts.gross : amounts.net }
}

const noAmounts = { net: null, tax: null, gross: null, amount: null, unitPriceNet: null } as const

// ---------------------------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------------------------

export type DraftViewLineInput = {
  /** The persisted line id, once the line has one. */
  id?: string | null
  /**
   * The key the client gave the line. It outlives the id, which changes whenever a save recreates the
   * line, so a row keeps its identity (and focus) while the draft is edited.
   */
  clientKey?: string
  description: string
  /** As entered. */
  quantity: string | number
  /** As entered, on the document's price basis. */
  unitPrice: string | number
  /** Required with `stored`: the line's complete classification. */
  vat?: DocumentLineInput["vat"]
  /**
   * The amounts the line was stored with, as strings at most at the currency's exponent.
   *
   * - A locked (agreement-linked) line always renders them, and is never repriced.
   * - The unlocked lines render theirs only when EVERY unlocked line has them; otherwise all unlocked
   *   lines are repriced together, because pricing groups lines and a partial mix would not add up.
   * - A legacy draft needs them on every line.
   *
   * The server passes `stored` and `vat` for every persisted row. The editor drops `stored` from all
   * unlocked lines on the first edit, since from then on the draft is repriced.
   */
  stored?: { net: string; tax: string; gross: string }
  /** The line cannot be edited (agreement-linked). It keeps `stored` whatever the other lines do. */
  locked?: boolean
}

export type DraftViewInput = {
  kind: "invoice" | "quote"
  status: string
  locale: string
  timezone: string
  currency: string
  pricesIncludeTax: boolean
  /**
   * How the stored draft was priced. A `legacy_per_line` draft is issued from its stored amounts, so
   * it shows them: every line needs `stored`, and a line without it does not calculate. Once it is
   * edited it is repriced: pass `v2`, and no `stored` on its unlocked lines.
   */
  calculationVersion: "v2" | "legacy_per_line"
  /** The document's VAT rate in percent; lines without their own classification use it. */
  taxRate: string | number
  lines: readonly DraftViewLineInput[]
  vatEvidence?: DraftVatEvidence | null
  /** A draft normally has none; one that already took its number keeps it. */
  number?: string | null
  /** The provisional next number. Dropped when the draft already has a number. */
  previewNumber?: string | null
  dates?: { issueDate?: string | null; supplyDate?: string | null; dueDate?: string | null; expiryDate?: string | null }
  /** Settings-derived seller details, including the payment details snapshot. */
  seller?: SellerSnapshot | null
  sellerPhone?: string | null
  logoUrl?: string | null
  buyer?: BuyerSnapshot | null
  contactId?: string | null
  notes?: string | null
  paymentReference?: string | null
}

type StoredLine = { net: Decimal; tax: Decimal; gross: Decimal; vat: ReturnType<typeof draftVatClassificationSchema.parse> }

/** `null` when the stored line cannot be read exactly; it then stops the document from calculating. */
function readStored(line: DraftViewLineInput, exponent: number, legacyUnlocked: boolean): StoredLine | null {
  if (!line.stored || !line.vat) return null
  // A legacy 0 % line written as "standard" is unclassified, as the migration made the ones it found
  // (`unclassified_zero`, which issuance refuses). Agreement-locked lines were converted when they were
  // copied onto the invoice, so they are read as they are.
  const legacyZero = legacyUnlocked && line.vat.treatment === "standard" && line.vat.rate !== undefined && !/[1-9]/.test(line.vat.rate)
  const vat = draftVatClassificationSchema.safeParse(legacyZero ? { ...line.vat, treatment: "unclassified_zero", reasonCode: null } : line.vat)
  if (!vat.success) return null
  const amounts: Decimal[] = []
  for (const value of [line.stored.net, line.stored.tax, line.stored.gross]) {
    if (!decimalStringSchema.safeParse(value).success) return null
    const amount = new D(value)
    if (!amount.toDecimalPlaces(exponent, D.ROUND_HALF_UP).eq(amount)) return null
    amounts.push(amount)
  }
  return { net: amounts[0]!, tax: amounts[1]!, gross: amounts[2]!, vat: vat.data }
}

type GroupSums = { treatment: VatTreatment; rate: string; reasonCode: VatReasonCode | null; country: string | null; net: Decimal; tax: Decimal; gross: Decimal; payableRounding: Decimal }

/**
 * The view of a draft. Amounts come only from `calculateDraft` and from stored amounts, which are
 * added with Decimal. A draft that cannot be calculated (an empty price, a decimal comma, too many
 * decimals, an unreadable stored line) has `totals: null`, no VAT groups and no amounts on the lines
 * that did not calculate. It is never guessed.
 *
 * Throws only for a currency without a supported precision.
 */
export function buildDraftView(input: DraftViewInput): DocumentView {
  const exponent = requireCurrencyExponent(input.currency)
  const legacy = input.calculationVersion === "legacy_per_line"
  const keys = uniqueKeys(input.lines.map((line, index) => line.clientKey || line.id || `line-${index + 1}`))
  const isLocked = (line: DraftViewLineInput) => !!line.locked && !!line.stored
  // Stored amounts stand for the unlocked lines only if every one of them has them (see `stored`).
  const unlockedStored = input.lines.filter((line) => !isLocked(line)).every((line) => line.stored)
  const prepared = input.lines.map((line, index) => ({
    line,
    key: keys[index]!,
    // undefined: priced from its inputs. null: stored, but unreadable. A legacy draft prices nothing.
    stored: legacy || isLocked(line) || (unlockedStored && line.stored)
      ? readStored(line, exponent, legacy && !isLocked(line))
      : undefined,
  }))

  const calculated = calculate(input, prepared.map((entry) => entry.stored), exponent)
  let nextCalculated = 0
  const lines: DocumentViewLine[] = prepared.map(({ line, key, stored }) => {
    const quantity = asEntered(line.quantity)
    const base = { key, id: line.id || null, description: line.description, quantity, unitPrice: asEntered(line.unitPrice), locked: line.locked ?? false }
    if (stored !== undefined) {
      return stored
        ? { ...base, vat: lineVat(stored.vat), ...lineAmounts(base.unitPrice, stored.vat.rate, stored.net, stored.tax, stored.gross, input.pricesIncludeTax, exponent) }
        : { ...base, vat: null, ...noAmounts }
    }
    const result = calculated?.lines[nextCalculated++]
    return {
      ...base, vat: result ? lineVat(result.vat) : enteredVat(line, input.taxRate),
      ...(result ? lineAmounts(base.unitPrice, result.vat.rate, new D(result.net), new D(result.tax), new D(result.gross), input.pricesIncludeTax, exponent) : noAmounts),
    }
  })

  const value = input.number ?? null
  const reference = input.paymentReference?.trim() || value
  return {
    version: 1, kind: input.kind, state: "draft", status: input.status,
    number: { value, preview: value === null ? input.previewNumber ?? null : null },
    locale: input.locale, timezone: input.timezone, currency: input.currency, exponent, pricesIncludeTax: input.pricesIncludeTax,
    seller: sellerView(input.seller, input.sellerPhone, input.logoUrl), buyer: buyerView(input.buyer, input.contactId),
    dates: {
      issueDate: calendarDate(input.dates?.issueDate), supplyDate: calendarDate(input.dates?.supplyDate),
      dueDate: calendarDate(input.dates?.dueDate), expiryDate: calendarDate(input.dates?.expiryDate),
    },
    lines, vatGroups: calculated?.vatGroups ?? [], totals: calculated?.totals ?? null,
    vatEvidence: evidenceView(input.vatEvidence), notes: notesView(input.notes),
    paymentDetails: paymentDetailsView(input.seller, reference || null, input.kind),
    correction: null,
    // An agreement-linked legacy draft is never upgraded (its locked lines stay as issued), so it is not stale.
    calculation: { version: input.calculationVersion, staleLegacy: legacy && !input.lines.some((line) => line.locked) },
  }
}

/** The classification of a line that did not calculate, as far as it can be read without guessing. */
function enteredVat(line: DraftViewLineInput, taxRate: string | number): DocumentViewLineVat | null {
  try {
    return lineVat(documentVat({ description: line.description, quantity: 1, unitPrice: 0, ...(line.vat ? { vat: line.vat } : {}) }, taxRate))
  } catch {
    return line.vat?.rate !== undefined
      ? { treatment: line.vat.treatment, rate: canonicalRate(line.vat.rate), reasonCode: line.vat.reasonCode ?? null, country: line.vat.country ?? null }
      : null
  }
}

type Calculated = {
  lines: Array<{ vat: StoredLine["vat"]; net: string; tax: string; gross: string }>
  vatGroups: DocumentViewVatGroup[]
  totals: NonNullable<DocumentView["totals"]>
}

function calculate(input: DraftViewInput, stored: Array<StoredLine | null | undefined>, exponent: number): Calculated | null {
  if (stored.some((entry) => entry === null)) return null
  const storedLines = stored.filter((entry): entry is StoredLine => entry !== undefined && entry !== null)
  const editable = input.lines.filter((_, index) => stored[index] === undefined)

  // Only the lines that are not stored are priced, as the server does. Whether the mix of
  // classifications may be issued is issuance's rule: the view shows what is stored.
  let priced: Calculated["lines"] = []
  const groups = new Map<string, GroupSums>()
  if (editable.length) {
    const preview = previewDraft({
      items: editable.map((line) => ({ description: line.description, quantity: line.quantity, unitPrice: line.unitPrice, ...(line.vat ? { vat: line.vat } : {}) })),
      taxRate: input.taxRate, currency: input.currency, pricesIncludeTax: input.pricesIncludeTax,
      ...(input.vatEvidence ? { vatEvidence: input.vatEvidence } : {}),
    })
    if (!preview.result) return null
    priced = preview.result.lines.map((line) => ({ vat: line.vat, net: line.net, tax: line.tax, gross: line.gross }))
    for (const group of preview.result.groups) {
      groups.set(group.key, {
        treatment: group.treatment, rate: group.rate, reasonCode: group.reasonCode, country: group.country,
        net: new D(group.net), tax: new D(group.tax), gross: new D(group.gross), payableRounding: new D(group.payableRounding),
      })
    }
  }
  for (const line of storedLines) {
    const key = vatGroupKey(line.vat)
    const group = groups.get(key) ?? {
      treatment: line.vat.treatment, rate: canonicalRate(line.vat.rate), reasonCode: line.vat.reasonCode, country: line.vat.country,
      net: new D(0), tax: new D(0), gross: new D(0), payableRounding: new D(0),
    }
    group.net = group.net.plus(line.net)
    group.tax = group.tax.plus(line.tax)
    group.gross = group.gross.plus(line.gross)
    // A stored line's own residual: what its gross holds beyond its net and tax.
    group.payableRounding = group.payableRounding.plus(line.gross.minus(line.net).minus(line.tax))
    groups.set(key, group)
  }
  const vatGroups: DocumentViewVatGroup[] = [...groups].map(([key, group]) => ({
    key, treatment: group.treatment, rate: group.rate, reasonCode: group.reasonCode, country: group.country,
    net: fixed(group.net, exponent), tax: fixed(group.tax, exponent), gross: fixed(group.gross, exponent),
    payableRounding: fixed(group.payableRounding, exponent),
  })).sort(byKey)

  const all = [...groups.values()]
  const gross = sum(all.map((group) => group.gross))
  return {
    lines: priced,
    vatGroups,
    totals: {
      net: fixed(sum(all.map((group) => group.net)), exponent), tax: fixed(sum(all.map((group) => group.tax)), exponent),
      gross: fixed(gross, exponent), payableRounding: fixed(sum(all.map((group) => group.payableRounding)), exponent),
      // A draft has no deposit applications, so everything gross is payable.
      payable: fixed(gross, exponent),
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Issued documents
// ---------------------------------------------------------------------------------------------

/**
 * The part of the issued money snapshot the view reads (`invoiceIssuedSchema`, the full
 * `creditNoteIssuedSchema` member and `invoiceMoneySnapshot` all satisfy it). It is structural because
 * shared cannot import from the app; the app proves its types are assignable.
 */
export type IssuedMoneySnapshot = {
  number: string
  issueDate: string
  supplyDate?: string | null
  /** A credit note has none. */
  dueDate?: string
  currency: string
  exponent: 0 | 1 | 2
  lines: ReadonlyArray<{
    lineId: string
    description: string
    quantityInput: string
    unitPriceInput: string
    net: string
    tax: string
    gross: string
    vat: { treatment: VatTreatment; rate: string; reasonCode: VatReasonCode | null; country: string | null }
  }>
  vatGroups: ReadonlyArray<{
    key: string
    treatment: VatTreatment
    rate: string
    reasonCode: VatReasonCode | null
    country: string | null
    net: string
    tax: string
    gross: string
    payableRounding: string
    evidence?: VatEvidence | undefined
  }>
  totals: { net: string; tax: string; gross: string; payableRounding: string }
  calculation: { version: "v2" | "legacy_per_line"; pricesIncludeTax: boolean }
  /**
   * An issued document has none today, so `payable` is its gross. Typed `never[]` so that a schema
   * which starts carrying deposit applications stops compiling until the view accounts for them.
   */
  depositApplications?: readonly never[]
  seller: SellerSnapshot
  buyer: BuyerSnapshot
  /** A credit note: the invoice it corrects and why. */
  correctsNumber?: string
  reason?: string
}

export type IssuedViewExtras = {
  kind: DocumentKind
  status: string
  locale: string
  timezone: string
  sellerPhone?: string | null
  logoUrl?: string | null
  contactId?: string | null
  notes?: string | null
  /** Defaults to the evidence the VAT groups agree on; null when they do not agree. */
  vatEvidence?: VatEvidence | null
  paymentReference?: string | null
  expiryDate?: string | null
  /** A credit note: when the invoice it corrects was issued. The snapshot does not record it. */
  correctsIssueDate?: string | null
}

/**
 * Raised for a snapshot that holds no money, such as the sparse credit notes written before issued
 * snapshots existed (the second member of `creditNoteIssuedSchema`). Stored snapshots are JSON, so the
 * types cannot rule it out. Callers fall back to the document's own rows.
 */
export class DocumentSnapshotIncomplete extends Error {
  readonly code = "document_snapshot_incomplete"
  constructor(readonly missing: string) {
    super(`The issued snapshot has no ${missing}, so it cannot be shown as a document view`)
    this.name = "DocumentSnapshotIncomplete"
  }
}

function assertComplete(snapshot: unknown): asserts snapshot is IssuedMoneySnapshot {
  const s = (typeof snapshot === "object" && snapshot !== null ? snapshot : {}) as Record<string, unknown>
  const missing = (["number", "issueDate", "currency"] as const).find((key) => typeof s[key] !== "string")
    ?? (["lines", "vatGroups"] as const).find((key) => !Array.isArray(s[key]))
    ?? (["totals", "calculation"] as const).find((key) => typeof s[key] !== "object" || s[key] === null)
    ?? (typeof s.exponent === "number" ? undefined : "exponent")
  if (missing) throw new DocumentSnapshotIncomplete(missing)
}

/**
 * The view of an issued document. Every amount is copied from the frozen snapshot: nothing is
 * calculated or repriced, so the view says what was issued whatever today's rules would give.
 *
 * Throws `DocumentSnapshotIncomplete` for a snapshot without money.
 */
export function buildIssuedView(snapshot: IssuedMoneySnapshot, extras: IssuedViewExtras): DocumentView {
  assertComplete(snapshot)
  const { pricesIncludeTax } = snapshot.calculation
  const keys = uniqueKeys(snapshot.lines.map((line) => line.lineId))
  const lines: DocumentViewLine[] = snapshot.lines.map((line, index) => ({
    key: keys[index]!, id: line.lineId, description: line.description,
    quantity: line.quantityInput, unitPrice: line.unitPriceInput,
    unitPriceNet: unitPriceNetOf(pricesIncludeTax, line.unitPriceInput, line.vat.rate),
    vat: lineVat(line.vat),
    net: line.net, tax: line.tax, gross: line.gross, amount: pricesIncludeTax ? line.gross : line.net,
    locked: true,
  }))
  const reference = extras.paymentReference?.trim() || snapshot.number
  const correction: DocumentViewCorrection | null = extras.kind === "creditNote" && snapshot.correctsNumber !== undefined && snapshot.reason !== undefined
    ? { invoiceNumber: snapshot.correctsNumber, invoiceIssueDate: calendarDate(extras.correctsIssueDate), reason: snapshot.reason }
    : null
  return {
    version: 1, kind: extras.kind, state: "issued", status: extras.status,
    number: { value: snapshot.number, preview: null },
    locale: extras.locale, timezone: extras.timezone, currency: snapshot.currency, exponent: snapshot.exponent, pricesIncludeTax,
    seller: sellerView(snapshot.seller, extras.sellerPhone, extras.logoUrl), buyer: buyerView(snapshot.buyer, extras.contactId),
    dates: {
      issueDate: calendarDate(snapshot.issueDate), supplyDate: calendarDate(snapshot.supplyDate),
      dueDate: calendarDate(snapshot.dueDate), expiryDate: calendarDate(extras.expiryDate),
    },
    lines,
    vatGroups: snapshot.vatGroups.map((group) => ({
      key: group.key, treatment: group.treatment, rate: canonicalRate(group.rate), reasonCode: group.reasonCode, country: group.country,
      net: group.net, tax: group.tax, gross: group.gross, payableRounding: group.payableRounding,
    })),
    // No deposit applications on an issued document (see the snapshot type), so the gross is what is payable.
    totals: {
      net: snapshot.totals.net, tax: snapshot.totals.tax, gross: snapshot.totals.gross,
      payableRounding: snapshot.totals.payableRounding, payable: snapshot.totals.gross,
    },
    vatEvidence: evidenceView(extras.vatEvidence !== undefined ? extras.vatEvidence : agreedEvidence(snapshot.vatGroups)),
    notes: notesView(extras.notes),
    paymentDetails: paymentDetailsView(snapshot.seller, reference, extras.kind),
    correction,
    calculation: { version: snapshot.calculation.version, staleLegacy: false },
  }
}

/** The pricing engine attaches the document's evidence to every group it covers; groups that differ have no single answer. */
function agreedEvidence(groups: IssuedMoneySnapshot["vatGroups"]): VatEvidence | null {
  const evidence = groups.flatMap((group) => group.evidence ? [group.evidence] : [])
  const first = evidence[0]
  if (!first || evidence.some((item) => JSON.stringify(item) !== JSON.stringify(first))) return null
  return first
}

// ---------------------------------------------------------------------------------------------
// Public view
// ---------------------------------------------------------------------------------------------

/**
 * What a customer may see of a view: no contact id and no line ids, and positional line keys
 * (`line-1`, `line-2`, ...) instead of ones derived from stored ids.
 */
export function toPublicDocumentView(view: DocumentView): PublicDocumentView {
  const { buyer, lines, ...rest } = view
  return {
    ...rest,
    buyer: buyer ? (({ contactId: _contactId, ...visible }) => visible)(buyer) : null,
    lines: lines.map(({ id: _id, ...line }, index) => ({ ...line, key: `line-${index + 1}` })),
  }
}
