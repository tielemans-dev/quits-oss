import type { TranslationKey } from "./messages"

export function translateCvrError(message: string, t: (key: TranslationKey) => string): string {
  return message === "cvr.invalid" || message === "cvr.inactive" || message === "cvr.unavailable"
    ? t(message)
    : message
}
