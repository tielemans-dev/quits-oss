import { accountingExportInputSchema, einvoiceExportInputSchema } from "@yaip/contracts/exports"
import { exportAccounting } from "../../../lib/exports/accounting"
import { exportEinvoice } from "../../../lib/exports/einvoice"
import { actorCan } from "../../actor"
import { Forbidden } from "../../errors"
import { defineQueryTool, type AgentTool } from "../define"

export const exportTools: AgentTool[] = [
  defineQueryTool({
    name: "export_einvoice",
    title: "Export e-invoice (Peppol UBL)",
    description:
      "Returns a Peppol BIS Billing 3.0 UBL XML file for an issued invoice or credit note. When data " +
      "is missing it returns ok: false with the list of missing fields instead of an invalid file.",
    input: einvoiceExportInputSchema,
    permission: "invoice:read",
    run: async ({ actor }, input) => {
      if (input.kind === "creditNote" && !actorCan(actor, "creditNote:read")) {
        throw new Forbidden({ message: "Missing permission creditNote:read", permission: "creditNote:read" })
      }
      return exportEinvoice(actor.organizationId, input.kind, input.id)
    },
  }),

  defineQueryTool({
    name: "export_accounting",
    title: "Export accounting CSV",
    description:
      "Returns a CSV of invoices, credit notes, or payments for an inclusive date range (YYYY-MM-DD, " +
      "the organization's calendar days), for bookkeeping systems.",
    input: accountingExportInputSchema,
    permission: "export:read",
    run: async ({ actor }, input) => exportAccounting(actor.organizationId, input),
  }),
]
