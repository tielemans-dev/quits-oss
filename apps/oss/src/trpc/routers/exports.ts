import { EinvoiceVatError } from "../../lib/exports/ubl"
import { TRPCError } from "@trpc/server"
import { accountingExportInputSchema, einvoiceExportInputSchema } from "@quits/contracts/exports"
import { actorCan } from "../../domain/actor"
import { exportAccounting } from "../../lib/exports/accounting"
import { EinvoiceSourceNotFound, exportEinvoice } from "../../lib/exports/einvoice"
import { authorizedProcedure, orgProcedure, router } from "../init"

export const exportsRouter = router({
  /** Peppol BIS Billing 3.0 UBL for an issued invoice or credit note, or the data it lacks. */
  einvoice: orgProcedure.input(einvoiceExportInputSchema).query(async ({ ctx, input }) => {
    const permission = input.kind === "invoice" ? "invoice:read" : "creditNote:read"
    if (!actorCan(ctx.actor, permission)) {
      throw new TRPCError({ code: "FORBIDDEN", message: `Your role does not allow ${permission}` })
    }
    try {
      return await exportEinvoice(ctx.organizationId, input.kind, input.id)
    } catch (error) {
      if (error instanceof EinvoiceSourceNotFound) {
        throw new TRPCError({ code: "NOT_FOUND", message: error.message })
      }
      if (error instanceof EinvoiceVatError) {
        throw new TRPCError({ code: "BAD_REQUEST", message: error.message, cause: error })
      }
      throw error
    }
  }),

  /** Accounting CSV of invoices, credit notes or payments for an inclusive date range. */
  accounting: authorizedProcedure("export:read")
    .input(accountingExportInputSchema)
    .query(({ ctx, input }) => exportAccounting(ctx.organizationId, input)),
})
