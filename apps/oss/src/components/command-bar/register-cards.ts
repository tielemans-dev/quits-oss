import { InvoiceRequestCard } from "./invoice-request-card"
import { CustomerRequestCard } from "./customer-request-card"
import { OverdueRequestCard } from "./overdue-request-card"
import { PaymentMatchCard } from "./payment-match-card"
import { registerRequestCard } from "./request-intent"

registerRequestCard("invoice", InvoiceRequestCard)
registerRequestCard("repeat", InvoiceRequestCard)
registerRequestCard("customer", CustomerRequestCard)
registerRequestCard("overdue", OverdueRequestCard)
registerRequestCard("payment", PaymentMatchCard)
