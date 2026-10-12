import type { BillingSubscription } from "./types"

export function formatPlanPrice(plan: NonNullable<BillingSubscription["plan"]>, locale: string) {
  const language = locale.toLowerCase().startsWith("da") ? "da" : "en"
  const minorUnits = plan.taxBehavior === "inclusive" ? Math.round(plan.unitAmount / 1.25) : plan.unitAmount
  const value = new Intl.NumberFormat(language === "da" ? "da-DK" : "en-GB", {
    maximumFractionDigits: 2,
  }).format(minorUnits / 100)
  return language === "da" ? `${value} kr./md.` : `${value} DKK/month`
}

export function formatPlanAmount(plan: NonNullable<BillingSubscription["plan"]>, locale: string) {
  const language = locale.toLowerCase().startsWith("da") ? "da" : "en"
  const value = new Intl.NumberFormat(language === "da" ? "da-DK" : "en-GB", {
    maximumFractionDigits: 2,
  }).format(plan.unitAmount / 100)
  return language === "da" ? `${value} kr.` : `${value} DKK`
}

export function formatTrialDate(unixSeconds: number, locale: string) {
  return new Intl.DateTimeFormat(locale.toLowerCase().startsWith("da") ? "da-DK" : "en-GB", {
    day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Copenhagen",
  }).format(new Date(unixSeconds * 1000))
}

export function trialDaysLeft(trialEnd: number, now = Date.now()) {
  return Math.max(0, Math.ceil((trialEnd * 1000 - now) / 86_400_000))
}
