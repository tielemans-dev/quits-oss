import { TRPCError } from "@trpc/server"
import { CurrencyPrecisionUnsupported, requireCurrencyExponent } from "@quits/shared/currency"

export function assertSettingsCurrency(currency: string | undefined) {
  if (currency === undefined) return
  try {
    requireCurrencyExponent(currency)
  } catch (error) {
    if (!(error instanceof CurrencyPrecisionUnsupported)) throw error
    throw new TRPCError({ code: "BAD_REQUEST", message: error.code, cause: error })
  }
}
