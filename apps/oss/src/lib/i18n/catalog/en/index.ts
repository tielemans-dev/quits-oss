import { enAgreementsMessages } from "./agreements"
import { enPaymentDetailsMessages } from "./payment-details"
import { enPaymentsMessages } from "./payments"
import { enCreditNotesMessages } from "./credit-notes"
import { enRemindersMessages } from "./reminders"
import { enRecurringMessages } from "./recurring"
import { enExportsMessages } from "./exports"
import { enAgentsMessages } from "./agents"
import { enActivityMessages } from "./activity"
import { enAuthMessages } from "./auth"
import { enBillingMessages } from "./billing"
import { enCatalogMessages } from "./catalog"
import { enClientActionsMessages } from "./client-actions"
import { enContactsMessages } from "./contacts"
import { enDashboardMessages } from "./dashboard"
import { enDocFormMessages } from "./doc-form"
import { enEmailMessages } from "./email"
import { enInvoicesMessages } from "./invoices"
import { enInvitationMessages } from "./invitation"
import { enNavMessages } from "./nav"
import { enPdfMessages } from "./pdf"
import { enPublicMessages } from "./public"
import { enQuotesMessages } from "./quotes"
import { enRootMessages } from "./root"
import { enSettingsMessages } from "./settings"
import { enSetupMessages } from "./setup"
import { enStatusMessages } from "./status"
import { enUiMessages } from "./ui"
import { enUserMessages } from "./user"

export const enCatalog = {
  ...enAgreementsMessages,
  ...enPaymentDetailsMessages,
  ...enPaymentsMessages,
  ...enCreditNotesMessages,
  ...enRemindersMessages,
  ...enRecurringMessages,
  ...enExportsMessages,
  ...enAgentsMessages,
  ...enActivityMessages,
  ...enAuthMessages,
  ...enBillingMessages,
  ...enCatalogMessages,
  ...enClientActionsMessages,
  ...enContactsMessages,
  ...enDashboardMessages,
  ...enDocFormMessages,
  ...enEmailMessages,
  ...enInvoicesMessages,
  ...enInvitationMessages,
  ...enNavMessages,
  ...enPdfMessages,
  ...enPublicMessages,
  ...enQuotesMessages,
  ...enRootMessages,
  ...enSettingsMessages,
  ...enSetupMessages,
  ...enStatusMessages,
  ...enUiMessages,
  ...enUserMessages,
} as const
