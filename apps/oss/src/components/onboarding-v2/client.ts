import { confirmOnboardingV2Schema } from "@quits/contracts/onboarding"
import type { CvrCompany, OnboardingSuggestions } from "@quits/contracts/cvr"
import { trpc } from "../../trpc/client"
import type { confirmationPayload } from "./draft"

/** Injectable transport, shared by the production route and browser fixtures. */
export type OnboardingV2Client = {
  search(query: string, signal: AbortSignal): Promise<CvrCompany[]>
  get(cvr: string, signal: AbortSignal): Promise<CvrCompany | null>
  suggestions?: (cvr: string, signal: AbortSignal) => Promise<OnboardingSuggestions>
  confirm(
    input: ReturnType<typeof confirmationPayload>,
  ): Promise<{ status: "complete" | "already_complete" }>
}

export function createOnboardingV2Client(suggestions: boolean): OnboardingV2Client {
  return {
    search: (q, signal) => trpc.cvr.search.query({ q }, { signal }),
    get: (cvr, signal) => trpc.cvr.get.query({ cvr }, { signal }),
    ...(suggestions
      ? {
          suggestions: (cvr: string, signal: AbortSignal) =>
            trpc.cvr.suggestions.query({ cvr }, { signal }),
        }
      : {}),
    confirm: (input) => trpc.onboarding.confirmV2.mutate(confirmOnboardingV2Schema.parse(input)),
  }
}
