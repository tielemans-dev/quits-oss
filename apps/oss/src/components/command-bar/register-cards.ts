import { InvoiceRequestCard } from "./invoice-request-card"
import { OverdueRequestCard } from "./overdue-request-card"
import { PaymentMatchCard } from "./payment-match-card"
import { registerRequestCard } from "./request-intent"

registerRequestCard("invoice", InvoiceRequestCard)
registerRequestCard("overdue", OverdueRequestCard)
registerRequestCard("payment", PaymentMatchCard)
