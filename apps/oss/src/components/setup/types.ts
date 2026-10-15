export type SetupStage = "new" | "initialized" | "complete"

export type SetupStatus = {
  isSetupComplete: boolean
  distribution: string
  setupVersion: number
  hasSeedData: boolean
  stage: SetupStage
  organizationId: string | null
  adminUserId: string | null
}

export type SetupWizardState = {
  instanceProfile: "freelancer" | "smb" | "enterprise"
  organizationName: string
  organizationSlug: string
  adminName: string
  adminEmail: string
  adminPassword: string
  authMode: "local_only" | "local_plus_oauth"
  locale: string
  countryCode: string
  timezone: string
  currency: string
  emailFromName: string
  emailReplyTo: string
}
