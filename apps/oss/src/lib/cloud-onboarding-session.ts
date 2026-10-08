import { getCloudOnboardingState, type CloudOnboardingState } from "./cloud-onboarding"

/**
 * Onboarding state of an organization, read from the database. The caller has already resolved
 * the session, so this never reads it again. The two independent queries run concurrently.
 */
export async function loadCloudOnboardingState(
  organizationId: string | null
): Promise<CloudOnboardingState> {
  if (!organizationId) {
    return getCloudOnboardingState(null)
  }

  const { prisma } = await import("./db")
  const [settings, primaryTaxId] = await Promise.all([
    prisma.orgSettings.findUnique({
      where: { organizationId },
      select: {
        onboardingStatus: true,
        onboardingMethod: true,
        onboardingProfile: true,
        onboardingInvoicingIdentity: true,
        onboardingVersion: true,
        onboardingCompletedAt: true,
        countryCode: true,
        locale: true,
        timezone: true,
        defaultCurrency: true,
        taxRegime: true,
        pricesIncludeTax: true,
        companyName: true,
        companyAddress: true,
        companyEmail: true,
        invoicePrefix: true,
        invoiceNextNum: true,
        quotePrefix: true,
        quoteNextNum: true,
      },
    }),
    prisma.organizationTaxId.findFirst({
      where: { organizationId },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      select: { value: true },
    }),
  ])

  return getCloudOnboardingState(
    settings
      ? {
          ...settings,
          primaryTaxId: primaryTaxId?.value ?? null,
        }
      : null
  )
}
