import { Effect } from "effect"
import type { CommandConsequences } from "@quits/contracts/agent"
import type { Agreement, Deliverable } from "../../../generated/prisma/client"
import { Command, Db } from "../services"

/** Acceptance makes work eligible later. It does not create invoices or collect money. */
export const agreementScheduleConsequences = (agreement: Agreement & { deliverables: Deliverable[] }) => Effect.gen(function* () {
  const db = yield* Db
  const { organizationId } = yield* Command
  const invoices = yield* Effect.promise(() => db.invoice.findMany({
    where: { organizationId, agreementId: agreement.id },
    select: { id: true, purpose: true, status: true, totalGross: true, currency: true, items: { select: { deliverableId: true } } },
  }))
  const schedule: NonNullable<CommandConsequences["schedule"]> = invoices.map(invoice => ({
    id: invoice.id, invoiceId: invoice.id, title: invoice.items.map(item => agreement.deliverables.find(line => line.id === item.deliverableId)?.title ?? "").filter(Boolean).join(", "),
    amount: invoice.totalGross.toFixed(2), currency: invoice.currency,
    kind: invoice.purpose === "prepayment" ? "prepayment" : "sale",
    state: invoice.status === "draft" ? "draft" : "issued",
  }))
  for (const line of agreement.deliverables) {
    if (line.status === "cancelled" || invoices.some(invoice => invoice.items.some(item => item.deliverableId === line.id))) continue
    schedule.push({ id: line.id, invoiceId: null, title: line.title, amount: line.lineGross.toFixed(2), currency: agreement.currency,
      kind: line.isDeposit ? "prepayment" : "sale", state: "future_eligibility" })
  }
  return schedule
})
