import { router } from "./init"
import { paymentsRouter } from "./routers/payments"
import { creditNotesRouter } from "./routers/credit-notes"
import { remindersRouter } from "./routers/reminders"
import { recurringRouter } from "./routers/recurring"
import { exportsRouter } from "./routers/exports"
import { agentsRouter } from "./routers/agents"
import { activityRouter } from "./routers/activity"
import { aiRouter } from "./routers/ai"
import { billingRouter } from "./routers/billing"
import { catalogRouter } from "./routers/catalog"
import { contactsRouter } from "./routers/contacts"
import { dashboardRouter } from "./routers/dashboard"
import { invoicesRouter } from "./routers/invoices"
import { onboardingRouter } from "./routers/onboarding"
import { onboardingAiRouter } from "./routers/onboarding-ai"
import { quotesRouter } from "./routers/quotes"
import { runtimeRouter } from "./routers/runtime"
import { setupRouter } from "./routers/setup"
import { settingsRouter } from "./routers/settings"

export const appRouter = router({
  payments: paymentsRouter,
  creditNotes: creditNotesRouter,
  reminders: remindersRouter,
  recurring: recurringRouter,
  exports: exportsRouter,
  agents: agentsRouter,
  activity: activityRouter,
  ai: aiRouter,
  billing: billingRouter,
  catalog: catalogRouter,
  contacts: contactsRouter,
  dashboard: dashboardRouter,
  invoices: invoicesRouter,
  onboarding: onboardingRouter,
  onboardingAi: onboardingAiRouter,
  quotes: quotesRouter,
  runtime: runtimeRouter,
  setup: setupRouter,
  settings: settingsRouter,
})

export type AppRouter = typeof appRouter
