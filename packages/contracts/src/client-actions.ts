import { z } from "zod"

/**
 * The client action page: one link that gathers the few things a customer may do about their
 * work with a seller. What a link may do is a list of grants, one per record, each naming the
 * capabilities the recipient holds on that record. Nothing is inferred from a customer company or
 * a contact: a grant on one invoice says nothing about the next.
 *
 * - `view`: read the record and download its final document.
 * - `pay`: pay the outstanding balance of an invoice. Never implies the right to sign anything.
 * - `approve`: decide an agreement or sign off a delivered revision.
 */
export const clientActionRecordKindSchema = z.enum(["agreement", "deliverable", "invoice"])
export type ClientActionRecordKind = z.infer<typeof clientActionRecordKindSchema>

export const clientActionCapabilitySchema = z.enum(["view", "pay", "approve"])
export type ClientActionCapability = z.infer<typeof clientActionCapabilitySchema>

/** Which capabilities exist for each kind of record. A payer is never offered `approve`. */
export const CLIENT_ACTION_CAPABILITIES: Readonly<
  Record<ClientActionRecordKind, readonly ClientActionCapability[]>
> = {
  agreement: ["view", "approve"],
  deliverable: ["view", "approve"],
  invoice: ["view", "pay"],
}

export const CLIENT_ACTION_MAX_GRANTS = 50
export const CLIENT_ACTION_MAX_EXPIRY_DAYS = 90
export const CLIENT_ACTION_DEFAULT_EXPIRY_DAYS = 30

/** `email_code`: the recipient proves control of the grant's email address before approving. */
export const clientActionVerificationSchema = z.enum(["none", "email_code"])
export type ClientActionVerification = z.infer<typeof clientActionVerificationSchema>

/**
 * The capabilities a grant stores. `view` is always present: paying or approving a record the
 * recipient cannot read would be a blind action.
 */
export function normalizeCapabilities(
  kind: ClientActionRecordKind,
  capabilities: readonly ClientActionCapability[],
): ClientActionCapability[] {
  const allowed = CLIENT_ACTION_CAPABILITIES[kind]
  const wanted = new Set<ClientActionCapability>(["view", ...capabilities])
  return allowed.filter((capability) => wanted.has(capability))
}

export const clientActionGrantInputSchema = z
  .object({
    kind: clientActionRecordKindSchema,
    recordId: z.string().min(1).max(100),
    capabilities: z.array(clientActionCapabilitySchema).min(1).max(3),
  })
  .strict()
  .superRefine((grant, context) => {
    const allowed = CLIENT_ACTION_CAPABILITIES[grant.kind]
    for (const capability of grant.capabilities) {
      if (!allowed.includes(capability)) {
        context.addIssue({
          code: "custom",
          path: ["capabilities"],
          message: `A ${grant.kind} cannot be granted "${capability}"`,
        })
      }
    }
  })
export type ClientActionGrantInput = z.infer<typeof clientActionGrantInputSchema>

/** An agreement decision names a signer, so it needs a recipient whose email is verified. */
export function clientActionNeedsVerification(
  grants: readonly { kind: ClientActionRecordKind; capabilities: readonly ClientActionCapability[] }[],
) {
  return grants.some((grant) => grant.kind === "agreement" && grant.capabilities.includes("approve"))
}

export const clientActionLinkCreateInputSchema = z
  .object({
    contactId: z.string().min(1).max(100),
    recipientName: z.string().trim().min(1).max(200),
    recipientEmail: z.string().trim().toLowerCase().email().max(320).nullish(),
    expiresInDays: z
      .number()
      .int()
      .min(1)
      .max(CLIENT_ACTION_MAX_EXPIRY_DAYS)
      .default(CLIENT_ACTION_DEFAULT_EXPIRY_DAYS),
    verification: clientActionVerificationSchema.default("none"),
    grants: z.array(clientActionGrantInputSchema).min(1).max(CLIENT_ACTION_MAX_GRANTS),
  })
  .strict()
  .superRefine((input, context) => {
    const seen = new Set<string>()
    for (const [index, grant] of input.grants.entries()) {
      const key = `${grant.kind}:${grant.recordId}`
      if (seen.has(key)) {
        context.addIssue({ code: "custom", path: ["grants", index], message: "Each record can be granted once" })
      }
      seen.add(key)
    }
    if (clientActionNeedsVerification(input.grants) && input.verification !== "email_code") {
      context.addIssue({
        code: "custom",
        path: ["verification"],
        message: "Deciding an agreement requires the recipient to verify their email address",
      })
    }
    if (input.verification === "email_code" && !input.recipientEmail) {
      context.addIssue({
        code: "custom",
        path: ["recipientEmail"],
        message: "Email verification needs the recipient's email address",
      })
    }
  })
export type ClientActionLinkCreateInput = z.infer<typeof clientActionLinkCreateInputSchema>

export const clientActionLinkIdInputSchema = z.object({ id: z.string().min(1).max(100) }).strict()

export const clientActionLinkRenewInputSchema = z
  .object({
    id: z.string().min(1).max(100),
    expiresInDays: z.number().int().min(1).max(CLIENT_ACTION_MAX_EXPIRY_DAYS),
  })
  .strict()

export const clientActionListInputSchema = z.object({ contactId: z.string().min(1).max(100) }).strict()

/** What a visitor of the page may ask for. Every action names the revision the visitor saw. */
export const clientActionRequestSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("agreement.accept"),
      agreementId: z.string().min(1).max(100),
      offerRevision: z.number().int().min(1),
      acceptedByName: z.string().trim().min(1).max(200),
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      type: z.literal("agreement.decline"),
      agreementId: z.string().min(1).max(100),
      offerRevision: z.number().int().min(1),
      reason: z.string().trim().max(5000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("deliverable.accept"),
      deliverableId: z.string().min(1).max(100),
      deliveryRevision: z.number().int().min(1),
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      type: z.literal("deliverable.request_changes"),
      deliverableId: z.string().min(1).max(100),
      deliveryRevision: z.number().int().min(1),
      note: z.string().trim().min(1).max(5000),
    })
    .strict(),
  z.object({ type: z.literal("invoice.pay"), invoiceId: z.string().min(1).max(100) }).strict(),
])
export type ClientActionRequest = z.infer<typeof clientActionRequestSchema>

/** Why a requested action did not happen, as the page can explain it to the visitor. */
export const clientActionRefusalSchema = z.enum([
  "inactive", // the link expired, was revoked, or never existed
  "not_permitted", // the link holds no such grant
  "verification_required", // an approver must first verify their email address
  "changed", // the record moved on since the visitor saw it
  "unavailable", // the record can no longer take this action
  "already_decided",
  "retry_later",
])
export type ClientActionRefusal = z.infer<typeof clientActionRefusalSchema>

export const clientActionCodeSchema = z.string().trim().regex(/^\d{6}$/)
