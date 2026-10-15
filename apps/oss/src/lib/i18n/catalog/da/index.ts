import { daSellerVatMessages } from "./seller-vat"
import { daOnboardingV2Messages } from "./onboarding-v2"
import { daAgreementsMessages } from "./agreements"
import { daPaymentDetailsMessages } from "./payment-details"
import { daPaymentsMessages } from "./payments"
import { daCreditNotesMessages } from "./credit-notes"
import { daRemindersMessages } from "./reminders"
import { daUndoMessages } from "./undo"
import { daRecurringMessages } from "./recurring"
import { daExportsMessages } from "./exports"
import { daAgentsMessages } from "./agents"
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
import { daValidationMessages } from "./validation"

export const daCatalog = {
  ...daSellerVatMessages,
  ...daOnboardingV2Messages,
  ...daAgreementsMessages,
  ...daPaymentDetailsMessages,
  ...daPaymentsMessages,
  ...daCreditNotesMessages,
  ...daRemindersMessages,
  ...daUndoMessages,
  ...daRecurringMessages,
  ...daExportsMessages,
  ...daAgentsMessages,
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
  ...daValidationMessages,
} as const
