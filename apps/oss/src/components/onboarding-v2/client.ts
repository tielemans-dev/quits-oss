import { confirmOnboardingV2Schema, confirmOnboardingV2WithVatConfirmationSchema } from "@quits/contracts/onboarding"
import type { CvrCompany, OnboardingSuggestions } from "@quits/contracts/cvr"
import { handledMutationError } from "../../lib/query-refresh"
import { trpc } from "../../trpc/client"
import { followStripeConnectUrl, stripeConnectRedirectUrl } from "../../lib/runtime/stripe-connect-settings"
import type { confirmationPayload } from "./draft"

/** Injectable transport, shared by the production route and browser fixtures. */
export type OnboardingV2Client = {
  search(query: string, signal: AbortSignal): Promise<CvrCompany[]>
  get(cvr: string, signal: AbortSignal): Promise<CvrCompany | null>
  suggestions?: (cvr: string, signal: AbortSignal) => Promise<OnboardingSuggestions>
  confirm(
    input: ReturnType<typeof confirmationPayload>,
  ): Promise<{ status: "complete" | "already_complete" }>
  /** Hosted only: offers card payments right after the company is saved. */
  payments?: {
    /** True when this organization can start Stripe Connect and has not yet connected. */
    available(): Promise<boolean>
    /** Opens Stripe's onboarding. Resolves false when the handler finished without a redirect. */
    connect(): Promise<boolean>
  }
}

export function createOnboardingV2Client(suggestions: boolean, confirmationEnabled = false, paymentsStep = false): OnboardingV2Client {
  return {
    search: (q, signal) => trpc.cvr.search.query({ q }, { signal }),
    get: (cvr, signal) => trpc.cvr.get.query({ cvr }, { signal }),
    ...(suggestions
      ? {
          suggestions: (cvr: string, signal: AbortSignal) =>
            trpc.cvr.suggestions.query({ cvr }, { signal }),
        }
      : {}),
    ...(paymentsStep
      ? {
          payments: {
            async available() {
              const settings = await trpc.settings.get.query()
              return settings.stripeAccount.mode === "connect" && settings.stripeConnectActions === true && settings.stripeAccount.status === "none"
            },
            async connect() {
              const result = await trpc.settings.runStripeConnectAction.mutate({ action: "connect" }, handledMutationError)
              const url = stripeConnectRedirectUrl(result.url)
              if (!url) return false
              followStripeConnectUrl(url)
              return true
            },
          },
        }
      : {}),
    async confirm(input) {
      const summary = (confirmationEnabled ? confirmOnboardingV2WithVatConfirmationSchema : confirmOnboardingV2Schema).parse(input)
      const token = confirmationEnabled ? (await trpc.runtime.prepareSellerVatConfirmation.mutate({
        companyName: summary.companyName, companyAddress: summary.companyAddress,
        countryCode: "DK", cvr: summary.cvr, vatId: summary.vatId,
      }, handledMutationError)).token : undefined
      return trpc.onboarding.confirmV2.mutate({ ...summary, ...(token ? { sellerVatConfirmationToken: token } : {}) }, handledMutationError)
    },
  }
}
