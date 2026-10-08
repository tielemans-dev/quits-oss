/** Reconstructs the actual payload expressions with synthetic writer state, without a database. */
import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"
import { commandErrorSchema } from "@quits/contracts/agent"
import ts from "typescript"
import { moneyEmitterState } from "./money-emitter-state"
import { acceptanceRecord } from "../../agreements/fulfillment"

export const emitterFiles = [
  ...["base-valuation", "invoices", "quotes", "credit-notes", "payments", "contacts", "recurring", "reminders", "agreements", "agreement-templates", "agreement-lifecycle", "deliverables", "public-deliverables", "invoices-from-deliverables", "billing-allocation", "payment-details"].map((name) => `commands/${name}.ts`),
  "agreements/billing.ts", "agreements/linked-invoice.ts", "documents/artifacts.ts", "documents/numbering.ts", "features/artifact-sweep.ts", "agreements/issuance.ts", "features/agreement-expiry.ts", "features/overdue.ts", "execute.ts", "approvals.ts", "agent-keys.ts", "documents/document-delivery.ts",
]
const root = new URL("../../", import.meta.url)

export function emitterExpressions() {
  const expressions: Array<{ source: string; typeExpression: string; payloadExpression: string }> = []
  for (const source of emitterFiles) {
    const text = readFileSync(new URL(source, root), "utf8")
    const ast = ts.createSourceFile(source, text, ts.ScriptTarget.Latest, true)
    function visit(node: ts.Node) {
      if (ts.isObjectLiteralExpression(node)) {
        const props = new Map(node.properties.flatMap((prop): Array<[string, ts.Node]> =>
          ts.isPropertyAssignment(prop) ? [[prop.name.getText(ast), prop.initializer]] :
          ts.isShorthandPropertyAssignment(prop) ? [[prop.name.getText(ast), prop.name]] : []))
        if (props.has("aggregateType") && props.has("aggregateId") && props.has("type") && props.has("payload")) {
          expressions.push({ source, typeExpression: props.get("type")!.getText(ast), payloadExpression: props.get("payload")!.getText(ast) })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
  return expressions
}

const instant = new Date("2026-01-15T12:00:00.000Z")
const money = { toFixed: () => "100.00", toNumber: () => 100, greaterThan: () => true }
const record = {
  id: "document-1", deliverableId: "deliverable-1", number: "DOC-0001", contactId: "contact-1", name: "Acme", title: "Website",
  sourceQuoteId: null, isDefault: false,
  currency: "USD", totalGross: money, status: "sent", autoSend: true, nextRunAt: instant,
  offerRevision: 1, offerSnapshot: { title: "Frozen offer" }, offerSnapshotHash: "hash-1",
  issuedToEmail: "customer@example.test", publicAccessKeyVersion: 1,
  acceptedAt: instant, acceptedOfferRevision: 1, acceptedByName: "Customer", acceptanceIp: "192.0.2.1",
  acceptanceUserAgent: "Fixture", acceptanceMethod: "internal", acceptanceEvidenceNote: "Written confirmation",
  declinedAt: null, declineReason: null, stripeCheckoutSessionId: null,
  publicRejectionReason: "Not needed", deliveryRevision: 1, acceptedRevision: 1, acceptedVia: "internal",
  disputedRevision: 1,
  dueDate: instant,
}

export const variants = [
  "default", "from_quote", "no_optional", "manual_no_recipient", "unchanged_retry", "validation_error", "user", "decline", "no_previous_acceptance", "in_progress", "completed",
  ...["invoice", "quote", "creditNote", "agreement"].flatMap((kind) =>
    ["send", "email"].flatMap((mode) => ["delivered", "rejected", "unconfirmed", "withdrawn"].map((reason) => `${kind}/${mode}/${reason}`))),
]

export function reconstruct(expression: { source: string; typeExpression: string; payloadExpression: string }, variant: string) {
  const [kind = "invoice", mode = "send", reason = "rejected"] = variant.includes("/") ? variant.split("/") : []
  const commandError = commandErrorSchema.parse({ tag: "InvalidState", message: "Fixture failure", ...(variant !== "no_optional" ? { code: "fixture_failure" } : {}), ...(variant === "validation_error" ? { issues: [{ path: "items", message: "Invalid items" }] } : {}) })
  const manual = variant === "manual_no_recipient"
  const optional = variant !== "no_optional"
  const line = { ...record, status: "delivered", ...(variant === "no_previous_acceptance" ? { acceptedAt: null } : {}) }
  const scope = {
    disputedInvoiceIds: ["invoice-1"],
    invoiceId: "invoice-1",
    documentKind: kind === "quote" ? "invoice" : kind, documentId: "document-1", candidateId: "candidate-1",
    organizationId: "organization-1", reservationId: "reservation-1", rendererVersion: "fixture-v1",
    artifacts: { pdf: { ref: "organization-1/invoice/document-1/artifact.pdf", hash: "a".repeat(64), size: 100 },
      ...(optional ? { ubl: { ref: "organization-1/invoice/document-1/artifact.xml", hash: "b".repeat(64), size: 200 } } : {}) },
    invoice: record, quote: record, creditNote: record, agreement: { ...record, sourceQuoteId: variant === "from_quote" ? "quote-1" : null }, template: record, contact: record, schedule: record,
    item: { invoiceId: "invoice-1" }, credit: { id: "credit-note-1" }, creditNoteIds: ["credit-note-1"], generation: 1,
    candidate: record, existing: line, line: { ...line, status: variant === "in_progress" ? "in_progress" : "delivered" },
    delivered: { deliveryRevision: 2 }, accepted: record, updated: expression.source === "commands/public-deliverables.ts" ? { ...record, acceptedVia: "customer_link", acceptanceEvidenceNote: null } : record,
    input: { ...(expression.source === "commands/billing-allocation.ts" ? { creditNoteId: "credit-note-1" } : {}), ...(expression.typeExpression.includes("agreement.completed") ? { disposition: variant === "completed" ? "completed" : "cancelled" } : {}), checkoutSessionId: "checkout-1", method: "bank_transfer", id: "document-1", mode: "full", reason: "Correction", acceptedByName: "Customer", evidenceNote: "Written confirmation", ...(expression.source === "commands/public-deliverables.ts" ? { note: "Please revise" } : {}), decision: variant === "decline" ? "rejected" : "accepted", runDate: "2026-01-15", invoiceId: "invoice-1", error: commandError, notes: "Changed" },
    decision: { decision: variant === "decline" ? "decline" : "accept", acceptedByName: "Customer", reason: optional ? "Not needed" : undefined },
    next: { publicRejectionReason: optional ? "Not needed" : null },
    current: optional, overpaidBy: { ...money, greaterThan: () => optional },
    payment: { id: "payment-1", amount: money, currency: "USD" },
    amount: money, refreshed: { settlement: { balanceDue: money, amountPaid: money, paymentStatus: "paid" }, invoice: record },
    priced: { totalGross: 100 }, built: { totalGross: 100 }, number: "DOC-0001", recipient: manual && ["agreements/issuance.ts", "commands/invoices.ts", "commands/quotes.ts"].includes(expression.source) ? null : "customer@example.test",
    reason: "paused_by_user", from: "active", to: "paused", status: expression.source === "commands/agreements.ts" && !optional ? undefined : variant === "in_progress" ? "in_progress" : "active",
    name: "Customer", method: manual ? "manual" : "email", unchanged: variant === "unchanged_retry", hash: "hash-1", policy: { enabled: true, offsetsDays: [-1, 0, 7] },
    data: expression.source === "commands/agreement-templates.ts" ? { name: "Updated" } : { name: "Updated", email: "customer@example.test" }, id: "deliverable-1", url: "https://example.test/read",
    runDate: instant, formatCalendarDate: () => "2026-01-15", balanceDue: money, paused: optional,
    reminder: { id: "reminder-1" }, skipReason: "not_open", manual: optional,
    // The email_failed return is reached only after the unconfirmed early return.
    failure: { reason: reason === "delivered" || (reason === "unconfirmed" && expression.typeExpression.includes("email_failed")) ? "rejected" : reason, message: "Fixture failure" },
    target: { documentId: "document-1", invoiceId: "invoice-1", number: "DOC-0001", recipient: manual && ["agreements/issuance.ts", "commands/invoices.ts", "commands/quotes.ts"].includes(expression.source) ? null : "customer@example.test", reminderId: "reminder-1", offsetDays: "7", balanceDue: "100.00" },
    payload: { offerRevision: 1, deliveryRevision: 1 } as Record<string, unknown>, command: { now: instant },
    definition: { type: "invoice.send" }, summary: "Send invoice", request: { commandType: "invoice.send", decisionNote: optional ? "Reviewed" : null },
    note: optional ? "Reviewed" : undefined, created: { name: "Bookkeeper", mode: "approval_required" }, scopes: ["invoice:read"],
    acceptanceRecord: (value: unknown) => acceptanceRecord(value as Parameters<typeof acceptanceRecord>[0]),
    kind, mode, aggregateType: kind === "creditNote" ? "credit_note" : kind,
    changes: [{ field: "iban", before: "DK****6243", after: "DK****1100" }, { field: "note", before: null, after: "****" }],
    changedBy: { kind: "user", id: "user-1", name: "Mette Admin", email: "mette@example.test" },
    deliveredEvent: (documentKind: string, deliveryMode: string) => deliveryMode === "send" || documentKind === "creditNote" ? "sent" : "email_resent",
  }
  if (expression.payloadExpression === "payload" && ["documents/artifacts.ts", "commands/base-valuation.ts"].includes(expression.source)) {
    // Evaluate the actual payload initializer against independent synthetic money state.
    const ast = ts.createSourceFile(expression.source, readFileSync(new URL(expression.source, root), "utf8"), ts.ScriptTarget.Latest, true)
    let initializer = ""
    function findPayload(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "payload" && node.initializer) initializer = node.initializer.getText(ast)
      ts.forEachChild(node, findPayload)
    }
    findPayload(ast)
    const moneyState = moneyEmitterState(scope.documentKind === "invoice" ? "invoice" : "creditNote")
    scope.payload = runInNewContext(`(${initializer})`, { ...scope, money: moneyState, snapshot: moneyState,
      command: { now: new Date("2026-10-07T12:00:00.000Z"), actor: { userId: "user-1" } },
      input: { ...scope.input, evidenceNote: "Reviewed source" },
      candidate: { ...scope.candidate, id: "candidate-1" },
    })

  }
  return {
    type: runInNewContext(`(${expression.typeExpression})`, scope) as string,
    payload: JSON.parse(JSON.stringify(runInNewContext(`(${expression.payloadExpression})`, scope))) as unknown,
  }
}
