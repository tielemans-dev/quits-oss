import { InvoiceActivityPanel } from "./activity-panel"
import { InvoiceCreditNotesPanel } from "./credit-notes-panel"
import { InvoiceExportsPanel } from "./exports-panel"
import { InvoicePaymentsPanel } from "./payments-panel"
import { InvoiceRemindersPanel } from "./reminders-panel"
import type { InvoicePanelProps } from "./types"

/** Lifecycle panels shown under an invoice. Each feature owns its own panel file. */
export function InvoiceLifecyclePanels(props: InvoicePanelProps) {
  return (
    <div className="mt-6 grid gap-6 no-print">
      <InvoicePaymentsPanel {...props} />
      <InvoiceCreditNotesPanel {...props} />
      <InvoiceRemindersPanel {...props} />
      <InvoiceExportsPanel {...props} />
      <InvoiceActivityPanel {...props} />
    </div>
  )
}
