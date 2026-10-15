import { normalizeTimeZone } from "../../lib/i18n/locale"
import type { TranslationKey } from "../../lib/i18n/messages"

/** The greeting for the hour the summary was taken, in the organization's time zone. */
export function greetingKey(asOf: string, timeZone: string | null | undefined): TranslationKey {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: normalizeTimeZone(timeZone) }).format(
      new Date(asOf)
    )
  )
  if (hour >= 5 && hour < 10) return "dashboard.greeting.morning"
  if (hour >= 10 && hour < 12) return "dashboard.greeting.forenoon"
  if (hour >= 12 && hour < 18) return "dashboard.greeting.afternoon"
  return "dashboard.greeting.evening"
}

/** What to call the person: the first word of their name, if they gave one. */
export function firstName(name: string | null | undefined): string | undefined {
  return name?.trim().split(/\s+/)[0] || undefined
}
