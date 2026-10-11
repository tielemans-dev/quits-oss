import { z } from "zod"
import {
  evaluateOnboardingReadiness,
  type OnboardingReadinessResult,
} from "./onboarding/readiness"

export const cloudOnboardingProfileSchema = z.enum(["freelancer", "smb", "enterprise"])
export const cloudOnboardingStatusSchema = z.enum([
  "not_started",
  "in_progress",
  "complete",
])

export type CloudOnboardingProfile = z.infer<typeof cloudOnboardingProfileSchema>
export type CloudOnboardingStatus = z.infer<typeof cloudOnboardingStatusSchema>

export const CLOUD_ONBOARDING_VERSION = 1

type CloudProfileDefaults = {
  taxRegime: "us_sales_tax" | "eu_vat" | "custom"
  pricesIncludeTax: boolean
  invoicePrefix: string
  quotePrefix: string
}

const profileDefaultsMap: Record<CloudOnboardingProfile, CloudProfileDefaults> = {
  freelancer: {
    taxRegime: "custom",
    pricesIncludeTax: false,
    invoicePrefix: "INV",
    quotePrefix: "QTE",
  },
  smb: {
    taxRegime: "us_sales_tax",
    pricesIncludeTax: false,
    invoicePrefix: "INV",
    quotePrefix: "QTE",
  },
  enterprise: {
    taxRegime: "custom",
    pricesIncludeTax: true,
    invoicePrefix: "INV",
    quotePrefix: "QTE",
  },
}

export type CloudOnboardingSettingsSnapshot = {
  onboardingStatus?: string | null
  onboardingMethod?: string | null
  onboardingProfile: string | null
  onboardingInvoicingIdentity?: string | null
  onboardingVersion: number | null
  onboardingCompletedAt: Date | null
  countryCode?: string | null
  locale?: string | null
  timezone?: string | null
  defaultCurrency?: string | null
  taxRegime?: string | null
  pricesIncludeTax?: boolean | null
  companyName?: string | null
  companyAddress?: string | null
  companyEmail?: string | null
  invoicePrefix?: string | null
  invoiceNextNum?: number | null
  quotePrefix?: string | null
  quoteNextNum?: number | null
  primaryTaxId?: string | null
} | null

export type CloudOnboardingState = {
  isComplete: boolean
  status: CloudOnboardingStatus
  profile: CloudOnboardingProfile | null
  version: number | null
  completedAt: Date | null
  readiness?: OnboardingReadinessResult
}

export function mapPersistedOnboardingStatus(
  value: string | null | undefined,
  completedAt: Date | null | undefined
): CloudOnboardingStatus {
  if (completedAt) {
    return "complete"
  }

  const parsed = cloudOnboardingStatusSchema.safeParse(value)
  return parsed.success ? parsed.data : "not_started"
}

export function getProfileDefaults(profile: CloudOnboardingProfile, now = new Date()) {
  return {
    ...profileDefaultsMap[profile],
    onboardingProfile: profile,
    onboardingVersion: CLOUD_ONBOARDING_VERSION,
    onboardingCompletedAt: now,
  }
}

export function getCloudOnboardingState(
  settings: CloudOnboardingSettingsSnapshot
): CloudOnboardingState {
  const parsedProfile = cloudOnboardingProfileSchema.safeParse(settings?.onboardingProfile)
  const profile = parsedProfile.success ? parsedProfile.data : null
  const completedAt = settings?.onboardingCompletedAt ?? null
  const status = mapPersistedOnboardingStatus(
    settings?.onboardingStatus,
    completedAt
  )
  const version = settings?.onboardingVersion ?? null

  const hasReadinessFields =
    settings &&
    ("companyName" in settings ||
      "companyAddress" in settings ||
      "companyEmail" in settings)
  const readiness = hasReadinessFields
      ? evaluateOnboardingReadiness({
        onboardingVersion: settings.onboardingVersion,
        countryCode: settings.countryCode ?? null,
        invoicingIdentity: settings.onboardingInvoicingIdentity ?? null,
        locale: settings.locale ?? null,
        timezone: settings.timezone ?? null,
        defaultCurrency: settings.defaultCurrency ?? null,
        taxRegime: settings.taxRegime ?? null,
        pricesIncludeTax: settings.pricesIncludeTax ?? null,
        companyName: settings.companyName ?? null,
        companyAddress: settings.companyAddress ?? null,
        companyEmail: settings.companyEmail ?? null,
        invoicePrefix: settings.invoicePrefix ?? null,
        invoiceNextNum: settings.invoiceNextNum ?? null,
        quotePrefix: settings.quotePrefix ?? null,
        quoteNextNum: settings.quoteNextNum ?? null,
        primaryTaxId: settings.primaryTaxId ?? null,
      })
    : undefined

  return {
    isComplete: status === "complete" && (readiness ? readiness.isComplete : true),
    status,
    profile,
    version,
    completedAt,
    readiness,
  }
}

export function shouldRedirectToCloudOnboarding(
  pathname: string,
  hasActiveOrganization: boolean,
  onboardingComplete: boolean
): "/onboarding" | "/" | null {
  if (!hasActiveOrganization) {
    return null
  }

  const isOnboardingPath =
    pathname === "/onboarding" || pathname.startsWith("/onboarding/")

  if (!onboardingComplete && !isOnboardingPath) {
    return "/onboarding"
  }

  if (onboardingComplete && isOnboardingPath) {
    return "/"
  }

  return null
}
