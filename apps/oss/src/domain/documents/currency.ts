import { Effect } from "effect"
import { requireCurrencyExponent } from "@quits/shared/currency"
import { InvalidState } from "../errors"

/** Creation boundary only. Existing documents keep their stored figures. */
export const requireDraftCurrency = (currency: string) => Effect.try({
  try: () => requireCurrencyExponent(currency),
  catch: () => new InvalidState({ code: "currency_precision_unsupported", message: `Unsupported currency precision: ${currency}` }),
})
