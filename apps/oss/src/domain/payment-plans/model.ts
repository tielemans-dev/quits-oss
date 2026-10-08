import { z } from "zod"
import { currencyCodeSchema } from "@quits/contracts/baseSchemas"
import { recurringCalendarDateSchema, recurringIntervalUnitSchema } from "@quits/contracts/recurring"
import { vatGroupSchema } from "@quits/contracts/vat"

/*
 * Contract prototype for one versioned owner per payment schedule (issue #25). Pure data and
 * schemas only: nothing here is persisted or wired into commands yet. The decision record is
 * docs/plans/2026-10-08-canonical-payment-schedule-design.md.
 *
 * Three layers never share a record:
 *   obligation  what the customer owes for what (accepted agreement scope, an issued invoice,
 *               or one period of a recurring instruction);
 *   plan        how one obligation becomes sale invoices or advance requests, or how one issued
 *               invoice's balance is collected over time;
 *   authority   permission to pull money from a saved payment method (boundary only, see #51).
 */

/** Integer minor units as a decimal string, the wire form already used by posting events. */
export const minorSchema = z.string().regex(/^(0|[1-9]\d*)$/, "Use integer minor units")
const positiveMinorSchema = minorSchema.refine((value) => value !== "0", "Must be greater than zero")
const idSchema = z.string().min(1).max(200)
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/)
export const calendarDateSchema = recurringCalendarDateSchema

/**
 * The canonical owner of an obligation and the exact version a plan was built from. A plan that
 * names an older offer revision or a different issued artifact is stale.
 */
export const obligationRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("agreement_services"), agreementId: idSchema, offerRevision: z.number().int().nonnegative(), offerSnapshotHash: hashSchema }),
  z.strictObject({ kind: z.literal("invoice"), invoiceId: idSchema, issuedArtifactHash: hashSchema }),
])
export type ObligationRef = z.infer<typeof obligationRefSchema>

/** Frozen facts a plan is validated against. Plans never copy these; they reference them. */
export const obligationSchema = z.strictObject({
  ref: obligationRefSchema,
  currency: currencyCodeSchema,
  /** Payable gross: the accepted agreement total, or an issued invoice's gross less credits and advance applications. */
  grossMinor: minorSchema,
  /** Frozen VAT groups of the obligation. Empty for v1 offers, which froze flat totals only. */
  vatGroups: z.array(vatGroupSchema),
  /** The date the obligation became binding: agreement acceptance or invoice issue date. */
  effectiveOn: calendarDateSchema,
  /**
   * Agreement lines. `scope` lines make up the accepted total (v1 deposit lines included);
   * `payment_schedule` lines are a v2 offer's payment schedule, which requests money against the
   * total and is never scope. Deposit lines are not fulfillable: they are never delivered.
   */
  deliverables: z.array(z.strictObject({
    deliverableId: idSchema, kind: z.enum(["scope", "payment_schedule"]), grossMinor: minorSchema,
    fulfillable: z.boolean(), cancelled: z.boolean(),
  })).default([]),
  /** An invoice's current due date: its implicit single-installment collection plan. */
  dueDate: calendarDateSchema.nullable().default(null),
})
export type Obligation = z.infer<typeof obligationSchema>
export type ObligationInput = z.input<typeof obligationSchema>

export const stepTriggerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("on_acceptance") }),
  z.strictObject({ kind: z.literal("on_date"), date: calendarDateSchema }),
  z.strictObject({ kind: z.literal("on_deliverables"), event: z.enum(["delivered", "accepted"]), deliverableIds: z.array(idSchema).min(1).max(100) }),
])
export type StepTrigger = z.infer<typeof stepTriggerSchema>

/**
 * A billing step bills either one scope deliverable at its frozen line values (today's
 * mechanism) or a share of the whole obligation, whose VAT composition is derived from the
 * obligation's frozen groups. One plan never mixes the two, so VAT stays exact.
 */
export const stepSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("share") }),
  z.strictObject({ kind: z.literal("deliverable"), deliverableId: idSchema }),
])
export const billingStepSchema = z.strictObject({
  stepId: idSchema, label: z.string().min(1).max(200), grossMinor: positiveMinorSchema,
  source: stepSourceSchema, trigger: stepTriggerSchema, dueInDays: z.number().int().min(0).max(365),
})
export type BillingStep = z.infer<typeof billingStepSchema>
export const advanceRequestSchema = z.strictObject({
  advanceId: idSchema, label: z.string().min(1).max(200), grossMinor: positiveMinorSchema,
  trigger: stepTriggerSchema, dueInDays: z.number().int().min(0).max(365),
})
export type AdvanceRequest = z.infer<typeof advanceRequestSchema>
export const collectionInstallmentSchema = z.strictObject({ installmentId: idSchema, grossMinor: positiveMinorSchema, dueDate: calendarDateSchema })
export type CollectionInstallment = z.infer<typeof collectionInstallmentSchema>

export const arrangementSchema = z.discriminatedUnion("kind", [
  /** Sale invoices that together bill the agreement obligation exactly once. */
  z.strictObject({ kind: z.literal("billing_steps"), steps: z.array(billingStepSchema).min(1).max(100) }),
  /**
   * Money requested before the sale, held as an advance and applied to the next sale invoice of
   * the same obligation. Advance documents stay gated on the Danish decision (#24).
   */
  z.strictObject({
    kind: z.literal("advance_then_billing"),
    advances: z.array(advanceRequestSchema).min(1).max(12),
    application: z.literal("next_sale_invoice"),
    steps: z.array(billingStepSchema).min(1).max(100),
  }),
  /** Staged collection of one issued invoice. Installment dates strictly increase. */
  z.strictObject({ kind: z.literal("collection_installments"), installments: z.array(collectionInstallmentSchema).min(1).max(60) }),
])
export type Arrangement = z.infer<typeof arrangementSchema>

/** A ratio share, resolved once into exact minor units when a version is created. */
export const shareInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("amount"), grossMinor: positiveMinorSchema }),
  z.strictObject({ kind: z.literal("ratio"), basisPoints: z.number().int().min(1).max(10_000) }),
])
export type ShareInput = z.infer<typeof shareInputSchema>

export const planActorSchema = z.strictObject({ kind: z.enum(["user", "agent", "automation", "migration", "customer"]), id: idSchema })
export const planSourceSchema = z.enum(["agreement_offer", "seller_amendment", "customer_request", "credit_rebase", "migration"])

/** One immutable version of the canonical plan for one obligation. */
export const planVersionSchema = z.strictObject({
  planId: idSchema,
  version: z.number().int().positive(),
  /** The previous version this one replaces; null only for version 1. */
  supersedes: z.number().int().positive().nullable(),
  obligation: obligationRefSchema,
  currency: currencyCodeSchema,
  arrangement: arrangementSchema,
  source: planSourceSchema,
  actor: planActorSchema,
  reason: z.string().max(500).nullable(),
})
export type PlanVersion = z.infer<typeof planVersionSchema>

/** How the customer agreed to a version. An accepted offer that contained the plan is consent. */
export const consentSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("offer_acceptance"), offerRevision: z.number().int().nonnegative(), acceptedOn: calendarDateSchema }),
  z.strictObject({ kind: z.literal("customer_consent"), evidenceRef: idSchema, recordedOn: calendarDateSchema }),
  z.strictObject({ kind: z.literal("not_required"), notifyCustomer: z.boolean() }),
])
export type Consent = z.infer<typeof consentSchema>

/** What editors, invoice lines and automations store instead of a copy of the plan. */
export const planRefSchema = z.strictObject({ planId: idSchema, version: z.number().int().positive(), stepId: idSchema.optional() })
export type PlanRef = z.infer<typeof planRefSchema>

/**
 * A repeat service. The instruction is its own canonical owner; each run is a separate period
 * obligation, so it never splits a fixed obligation. Cadence math is the recurrence executor's.
 */
export const recurringInstructionSchema = z.strictObject({
  recurringInvoiceId: idSchema,
  version: z.number().int().positive(),
  currency: currencyCodeSchema,
  periodGrossMinor: positiveMinorSchema,
  intervalUnit: recurringIntervalUnitSchema,
  intervalCount: z.number().int().min(1).max(12),
  /** The cadence anchor (`RecurringInvoice.startDate`); monthly runs keep its day of month. */
  anchorDate: calendarDateSchema,
  /** The first run date this version governs. Earlier runs keep the version they were generated under. */
  effectiveFrom: calendarDateSchema,
  dueInDays: z.number().int().min(0).max(120),
  end: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("none") }),
    z.strictObject({ type: z.literal("on_date"), endsAt: calendarDateSchema }),
    z.strictObject({ type: z.literal("after_runs"), runs: z.number().int().min(1).max(1000) }),
  ]),
  /** Generation and sending. Never implies that money is collected automatically. */
  delivery: z.enum(["draft_only", "auto_send"]),
  /** Manual unless a saved-method authority exists; see `collectionAuthoritySchema`. */
  collection: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("manual") }),
    z.strictObject({ kind: z.literal("saved_method"), authorityId: idSchema }),
  ]),
})
export type RecurringInstruction = z.infer<typeof recurringInstructionSchema>

/**
 * Boundary for a future saved-method authority (a card on file or a debit mandate). Recorded so
 * plan and recurring amendments can tell when one would need renewal; #51 decides whether to
 * build it. Nothing in Quits creates one today.
 */
export const collectionAuthoritySchema = z.strictObject({
  authorityId: idSchema,
  version: z.number().int().positive(),
  status: z.enum(["active", "revoked", "expired"]),
  scope: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("plan"), planId: idSchema, version: z.number().int().positive() }),
    z.strictObject({ kind: z.literal("recurring"), recurringInvoiceId: idSchema, version: z.number().int().positive() }),
  ]),
  currency: currencyCodeSchema,
  /** Largest single charge the payer agreed to. */
  maxChargeMinor: positiveMinorSchema,
  /** Fewest days between two charges the payer agreed to. */
  minDaysBetweenCharges: z.number().int().min(0).max(366),
  consentEvidenceRef: idSchema,
})
export type CollectionAuthority = z.infer<typeof collectionAuthoritySchema>

export type PlanRefusalCode =
  | "currency_mismatch" | "currency_unsupported" | "sub_minor_amount" | "total_mismatch" | "ratio_total_mismatch"
  | "duplicate_step" | "unknown_deliverable" | "deliverable_not_scope" | "dates_not_increasing" | "date_before_obligation"
  | "arrangement_not_allowed" | "advance_exceeds_obligation" | "obligation_mismatch" | "stale_obligation_version"
  | "stale_plan_version" | "plan_already_authoritative" | "version_sequence" | "amendment_pending"
  | "automation_cannot_amend" | "issued_step_immutable" | "paid_installment_immutable" | "stale_settlement"
  | "stale_plan_reference" | "amount_requires_plan_amendment" | "earlier_due_requires_consent" | "recurring_cannot_split_fixed_obligation"
  | "no_pending_amendment" | "consent_does_not_match" | "mixed_step_sources" | "vat_groups_unavailable"
  | "received_advance_immutable" | "double_counted" | "over_application" | "trigger_not_fulfillable"
  | "invalid_position" | "duplicate_position_entry"
  | "exception_reason_required" | "effective_date_in_past" | "duplicate_instruction"
export type PlanRefusal = { code: PlanRefusalCode; detail: string }
export const refuse = (code: PlanRefusalCode, detail: string): PlanRefusal => ({ code, detail })
