import { InvoiceRequestCard } from "./invoice-request-card"
import { CustomerRequestCard } from "./customer-request-card"
import { OverdueRequestCard } from "./overdue-request-card"
import { registerRequestCard } from "./request-intent"

registerRequestCard("invoice", InvoiceRequestCard)
registerRequestCard("customer", CustomerRequestCard)
registerRequestCard("overdue", OverdueRequestCard)
