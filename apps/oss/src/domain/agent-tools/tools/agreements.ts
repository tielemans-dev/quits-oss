import { agreementFromQuoteInputSchema, agreementTermsSchema } from "@quits/contracts/agreements"
import { deliverableProgress } from "../../agreements/progress"
import { markDeliverableDelivered } from "../../commands/deliverables"
import { deliverableIdInputSchema } from "@quits/contracts/agreements"
import {
  sendAgreement,
  issueAgreement,
  resendAgreement,
  sendAgreementReadLink,
} from "../../commands/agreement-lifecycle"
import { agreementIssueInputSchema, agreementResendInputSchema } from "@quits/contracts/agreements"
import {
  agreementCreateDraftDecimalInputSchema,
  agreementUpdateDraftDecimalInputSchema,
  agreementIdInputSchema,
  agreementListInputSchema,
  deliverableUpdateDecimalInputSchema,
} from "@quits/contracts/agreements"
import {
  createAgreementDraft,
  updateAgreementDraft,
  deleteAgreementDraft,
  updateDeliverable,
} from "../../commands/agreements"
import { listAgreements, getAgreement } from "../../agreements/queries"
import { describeAllocations } from "../../agreements/allocations"
import { actorCan, type AgentActor } from "../../actor"
import { prisma } from "../../../lib/db"

/** Adds each deliverable's billing allocation: its state, the draft or invoice holding it, and rebill decisions. */
async function withAllocations<Agreement extends { id: string; deliverables: Array<{ id: string; billingStatus: string; billingGeneration: number }> }>(actor: AgentActor, agreement: Agreement) {
  const views = await describeAllocations(prisma, actor.organizationId, agreement.id, agreement.deliverables, { invoices: actorCan(actor, "invoice:read"), creditNotes: actorCan(actor, "creditNote:read") })
  return { ...agreement, deliverables: agreement.deliverables.map(line => ({ ...line, allocation: views.get(line.id)! })) }
}
import { listAgreementTemplates } from "../../agreements/templates"
import { defineQueryTool, defineCommandTool, type AgentTool } from "../define"
import { z } from "zod"
import { toPage } from "../pagination"
const agreementListToolInputSchema = agreementListInputSchema.extend({
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().max(500).optional(),
})

export const agreementTools: AgentTool[] = [
  defineCommandTool({
    name: "agreement_create_draft_from_quote",
    title: "Create agreement draft from quote",
    description: "Creates an agreement draft from an accepted quote under the quote lock. Refused if the quote has invoices or an agreement. Copies exact decimal inputs, customer and tax context, with every quote line becoming a service deliverable. Supply a fresh validUntil in YYYY-MM-DD. Optional templateId, termsMarkdown, title, dueInDays and billingTrigger. Nothing is sent.",
    command: createAgreementDraft,
    input: agreementFromQuoteInputSchema,
  }),
  defineCommandTool({
    name: "deliverable_mark_delivered",
    title: "Mark deliverable delivered",
    description:
      "Marks planned, in-progress or changes-requested work delivered on an accepted agreement. Excludes deposits. Increments deliveryRevision and clears current acceptance. Requires approval in approval_required mode. Notifies issuedToEmail when email is available and returns the 90-day sign-off link for manual sharing.",
    command: markDeliverableDelivered,
    input: deliverableIdInputSchema,
  }),
  defineCommandTool({
    name: "agreement_send",
    title: "Send agreement",
    description:
      "Freezes and emails the draft offer to the contact email. Delivery refusal leaves a draft.",
    command: sendAgreement,
    input: agreementIdInputSchema,
  }),
  defineCommandTool({
    name: "agreement_issue",
    title: "Issue agreement",
    description:
      "Makes a draft offer live without email. An optional recipient is recorded as the intended recipient.",
    command: issueAgreement,
    input: agreementIssueInputSchema,
  }),
  defineCommandTool({
    name: "agreement_resend",
    title: "Resend agreement",
    description:
      "Emails the same live offer, rotating its links. Optional recipient changes are audited. Does not extend validity.",
    command: resendAgreement,
    input: agreementResendInputSchema,
  }),
  defineCommandTool({
    name: "agreement_send_read_link",
    title: "Send agreement read link",
    description:
      "Emails a fresh two-year read link for the accepted agreement to its intended recipient. Does not rotate the key.",
    command: sendAgreementReadLink,
    input: agreementIdInputSchema,
  }),
  defineQueryTool({
    name: "agreement_list",
    title: "List agreements",
    description:
      "Lists agreements with status, offer revision and acceptance fields, newest first. Filter by status or contactId. Returns { items, nextCursor }; pass nextCursor for another page.",
    permission: "agreement:read",
    input: agreementListToolInputSchema,
    run: async ({ actor }, input) => {
      const { limit, cursor, ...filter } = input
      const rows = await listAgreements(actor.organizationId, filter, {
        limit,
        cursor,
      })
      return toPage(rows, limit, (row) => row.createdAt.toISOString())
    },
  }),
  defineQueryTool({
    name: "agreement_get",
    title: "Get agreement",
    description:
      "Returns an agreement with status, offer revision, acceptance record, customer, progress, deliverables, fulfillment status, deliveryRevision, current acceptance, billing status and allocation (state, holding draft or invoice, credits, rebill decisions), changes_requested and changeRequestNote.",
    permission: "agreement:read",
    input: agreementIdInputSchema,
    run: async ({ actor }, input) => {
      const agreement = await getAgreement(actor.organizationId, input.id)
      return {
        ...(await withAllocations(actor, agreement)),
        progress: deliverableProgress(agreement.deliverables),
      }
    },
  }),
  defineQueryTool({
    name: "deliverable_list",
    title: "List deliverables",
    description:
      "Lists deliverables in agreement order, with fulfillment status, deliveryRevision, current acceptance, billing status, changes_requested and changeRequestNote.",
    permission: "deliverable:read",
    input: z.object({ agreementId: z.string().min(1) }).strict(),
    run: async ({ actor }, input) =>
      (await withAllocations(actor, await getAgreement(actor.organizationId, input.agreementId))).deliverables,
  }),
  defineQueryTool({
    name: "agreement_template_list",
    title: "List agreement templates",
    description:
      "Returns the organization's seeded templates. These examples are not legal advice.",
    permission: "agreement:read",
    input: z.object({}).strict(),
    run: ({ actor }) => listAgreementTemplates(actor.organizationId),
  }),
  defineCommandTool({
    name: "agreement_create_draft",
    title: "Create agreement draft",
    description:
      "Creates a draft agreement. Dates are YYYY-MM-DD; quantity, unitPrice and taxRate are decimal strings. A template seeds terms when termsMarkdown is omitted. No number is allocated and nothing is sent. Use agreement_create_draft_from_quote to convert an accepted quote.",
    command: createAgreementDraft,
    input: agreementCreateDraftDecimalInputSchema.extend({ termsMarkdown: agreementTermsSchema.optional() }),
  }),
  defineCommandTool({
    name: "agreement_update_draft",
    title: "Update agreement draft",
    description:
      "Edits a draft agreement. Passing deliverables replaces all lines. Omitted fields remain unchanged.",
    command: updateAgreementDraft,
    input: agreementUpdateDraftDecimalInputSchema,
  }),
  defineCommandTool({
    name: "agreement_delete_draft",
    title: "Delete agreement draft",
    description:
      "Deletes a draft agreement and its deliverables. Refused while an approval is pending.",
    command: deleteAgreementDraft,
    input: agreementIdInputSchema,
  }),
  defineCommandTool({
    name: "deliverable_update",
    title: "Update deliverable",
    description:
      "Edits offer fields only in drafts, or expectedDate in any agreement state. Set status to in_progress to start planned work or reopen delivered/accepted unbilled work on an accepted agreement. Deposits cannot enter fulfillment.",
    command: updateDeliverable,
    input: deliverableUpdateDecimalInputSchema,
  }),
]
