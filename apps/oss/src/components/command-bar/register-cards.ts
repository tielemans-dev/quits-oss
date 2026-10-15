import { InvoiceRequestCard } from "./invoice-request-card"
import { OverdueRequestCard } from "./overdue-request-card"
import { registerRequestCard } from "./request-intent"

registerRequestCard("invoice", InvoiceRequestCard)
registerRequestCard("repeat", InvoiceRequestCard)
registerRequestCard("overdue", OverdueRequestCard)
