import { daAgreementsMessages } from "./agreements"
import { daPaymentDetailsMessages } from "./payment-details"
import { daPaymentsMessages } from "./payments"
import { daCreditNotesMessages } from "./credit-notes"
import { daRemindersMessages } from "./reminders"
import { daRecurringMessages } from "./recurring"
import { daExportsMessages } from "./exports"
import { daAgentsMessages } from "./agents"
import { daConnectorsMessages } from "./connectors"
import { daActivityMessages } from "./activity"
import { daAuthMessages } from "./auth"
import { daBillingMessages } from "./billing"
import { daCatalogMessages } from "./catalog"
import { daContactsMessages } from "./contacts"
import { daDashboardMessages } from "./dashboard"
import { daDocFormMessages } from "./doc-form"
import { daEmailMessages } from "./email"
import { daInvoicesMessages } from "./invoices"
import { daInvitationMessages } from "./invitation"
import { daNavMessages } from "./nav"
import { daPdfMessages } from "./pdf"
import { daPublicMessages } from "./public"
import { daQuotesMessages } from "./quotes"
import { daRootMessages } from "./root"
import { daSettingsMessages } from "./settings"
import { daSetupMessages } from "./setup"
import { daStatusMessages } from "./status"
import { daUiMessages } from "./ui"
import { daUserMessages } from "./user"

export const daCatalog = {
  ...daAgreementsMessages,
  ...daPaymentDetailsMessages,
  ...daPaymentsMessages,
  ...daCreditNotesMessages,
  ...daRemindersMessages,
  ...daRecurringMessages,
  ...daExportsMessages,
  ...daAgentsMessages,
  ...daConnectorsMessages,
  ...daActivityMessages,
  ...daAuthMessages,
  ...daBillingMessages,
  ...daCatalogMessages,
  ...daContactsMessages,
  ...daDashboardMessages,
  ...daDocFormMessages,
  ...daEmailMessages,
  ...daInvoicesMessages,
  ...daInvitationMessages,
  ...daNavMessages,
  ...daPdfMessages,
  ...daPublicMessages,
  ...daQuotesMessages,
  ...daRootMessages,
  ...daSettingsMessages,
  ...daSetupMessages,
  ...daStatusMessages,
  ...daUiMessages,
  ...daUserMessages,
} as const
