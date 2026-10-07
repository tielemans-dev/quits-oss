import {
  agreementCreateDraftInputSchema,
  agreementUpdateDraftInputSchema,
  agreementIdInputSchema,
  agreementListInputSchema,
  deliverableUpdateInputSchema,
} from "@quits/contracts/agreements"
import {
  createAgreementDraft,
  updateAgreementDraft,
  deleteAgreementDraft,
  updateDeliverable,
} from "../../commands/agreements"
import { listAgreements, getAgreement } from "../../agreements/queries"
import { listAgreementTemplates } from "../../agreements/templates"
import { defineQueryTool, defineCommandTool, type AgentTool } from "../define"
import { z } from "zod"
import { toPage } from "../pagination"
const agreementListToolInputSchema = agreementListInputSchema.extend({
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().max(500).optional(),
})

export const agreementTools: AgentTool[] = [
  defineQueryTool({
    name: "agreement_list",
    title: "List agreements",
    description:
      "Lists agreement drafts, newest first. Filter by status or contactId. Returns { items, nextCursor }; pass nextCursor for another page.",
    permission: "agreement:read",
    input: agreementListToolInputSchema,
    run: async ({ actor }, input) => {
      const { limit, cursor, ...filter } = input
      const rows = await listAgreements(actor.organizationId, filter, { limit, cursor })
      return toPage(rows, limit, (row) => row.createdAt.toISOString())
    },
  }),
  defineQueryTool({
    name: "agreement_get",
    title: "Get agreement",
    description: "Returns an agreement with its customer, deliverables, prices and draft context.",
    permission: "agreement:read",
    input: agreementIdInputSchema,
    run: ({ actor }, input) => getAgreement(actor.organizationId, input.id),
  }),
  defineQueryTool({
    name: "deliverable_list",
    title: "List deliverables",
    description: "Lists deliverables in agreement order, with fulfillment and billing status.",
    permission: "deliverable:read",
    input: z.object({ agreementId: z.string().min(1) }).strict(),
    run: async ({ actor }, input) =>
      (await getAgreement(actor.organizationId, input.agreementId)).deliverables,
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
      "Creates a draft agreement. No number is allocated and nothing is sent. Dates are YYYY-MM-DD, taxRate is one percentage for every deliverable.",
    command: createAgreementDraft,
    input: agreementCreateDraftInputSchema,
  }),
  defineCommandTool({
    name: "agreement_update_draft",
    title: "Update agreement draft",
    description:
      "Edits a draft agreement. Passing deliverables replaces all lines. Omitted fields remain unchanged.",
    command: updateAgreementDraft,
    input: agreementUpdateDraftInputSchema,
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
    title: "Update draft deliverable",
    description:
      "Edits offer fields or the expected date of a draft deliverable. Does not change fulfillment or billing status.",
    command: updateDeliverable,
    input: deliverableUpdateInputSchema,
  }),
]
