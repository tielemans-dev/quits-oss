import { useEffect, useMemo, useState } from "react"
import { Button } from "../ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "../ui/card"
import { forgetInstallationStatus } from "../../lib/installation-cache"
import { useI18n } from "../../lib/i18n/react"
import { trpc } from "../../trpc/client"
import { AdminOrgStep } from "./steps/step-admin-org"
import { AuthConfigStep } from "./steps/step-auth-config"
import { EmailFinishStep } from "./steps/step-email-finish"
import { InstanceProfileStep } from "./steps/step-instance-profile"
import type { SetupStatus, SetupStage, SetupWizardState } from "./types"

const WIZARD_STORAGE_KEY = "quits.setup.wizard.v1"
/** Where drafts were saved before the product was renamed; read once, then removed. */
const LEGACY_WIZARD_STORAGE_KEY = "yaip.setup.wizard.v1"

const DEFAULT_SETUP_STATE: SetupWizardState = {
  instanceProfile: "smb",
  organizationName: "",
  organizationSlug: "",
  adminName: "",
  adminEmail: "",
  adminPassword: "",
  authMode: "local_only",
  locale: "en-US",
  countryCode: "US",
  timezone: "UTC",
  currency: "USD",
  emailFromName: "",
  emailReplyTo: "",
}

type SetupWizardProps = {
  initialStatus: SetupStatus
  onCompleted: () => void
}

export function slugifyOrganizationName(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
}

export function deriveInitialStep(stage: SetupStage) {
  return stage === "new" ? 1 : 4
}

export function buildSetupInitializePayload(state: SetupWizardState) {
  const emailFromName = state.emailFromName.trim()
  const emailReplyTo = state.emailReplyTo.trim().toLowerCase()

  return {
    instanceProfile: state.instanceProfile,
    organization: {
      name: state.organizationName.trim(),
      slug: state.organizationSlug.trim(),
    },
    admin: {
      name: state.adminName.trim(),
      email: state.adminEmail.trim().toLowerCase(),
      password: state.adminPassword,
    },
    auth: {
      mode: state.authMode,
    },
    locale: {
      locale: state.locale.trim(),
      countryCode: state.countryCode.trim().toUpperCase(),
      timezone: state.timezone.trim(),
      currency: state.currency.trim().toUpperCase(),
    },
    email: {
      fromName: emailFromName || undefined,
      replyTo: emailReplyTo || undefined,
    },
  } as const
}

function loadDraftState(): SetupWizardState {
  if (typeof window === "undefined") {
    return DEFAULT_SETUP_STATE
  }

  try {
    const raw =
      window.localStorage.getItem(WIZARD_STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_WIZARD_STORAGE_KEY)
    if (!raw) {
      return DEFAULT_SETUP_STATE
    }
    const parsed = JSON.parse(raw) as Partial<SetupWizardState>
    return { ...DEFAULT_SETUP_STATE, ...parsed }
  } catch {
    return DEFAULT_SETUP_STATE
  }
}

function isStepValid(step: number, state: SetupWizardState) {
  if (step === 1) {
    return Boolean(state.instanceProfile)
  }
  if (step === 2) {
    return Boolean(
      state.organizationName.trim() &&
        state.organizationSlug.trim() &&
        state.adminName.trim() &&
        state.adminEmail.trim() &&
        state.adminPassword.length >= 8
    )
  }
  if (step === 3) {
    return Boolean(state.authMode)
  }
  return Boolean(
    state.locale.trim() &&
      state.countryCode.trim().length === 2 &&
      state.timezone.trim() &&
      state.currency.trim().length === 3
  )
}

export function SetupWizard({ initialStatus, onCompleted }: SetupWizardProps) {
  const { t } = useI18n()
  const [setupState, setSetupState] = useState<SetupWizardState>(loadDraftState)
  const [step, setStep] = useState<number>(deriveInitialStep(initialStatus.stage))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [slugTouched, setSlugTouched] = useState(false)

  useEffect(() => {
    setStep(deriveInitialStep(initialStatus.stage))
  }, [initialStatus.stage])

  useEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(WIZARD_STORAGE_KEY, JSON.stringify(setupState))
    // The draft now lives under the new key; drop the old copy (it can hold the admin password).
    window.localStorage.removeItem(LEGACY_WIZARD_STORAGE_KEY)
  }, [setupState])

  const currentStepValid = useMemo(() => isStepValid(step, setupState), [step, setupState])
  const isLastStep = step === 4

  async function handleFinish() {
    setError(null)
    setSubmitting(true)
    try {
      if (initialStatus.stage === "new") {
        await trpc.setup.initialize.mutate(buildSetupInitializePayload(setupState))
      }
      await trpc.setup.complete.mutate()

      if (typeof window !== "undefined") {
        window.localStorage.removeItem(WIZARD_STORAGE_KEY)
        window.localStorage.removeItem(LEGACY_WIZARD_STORAGE_KEY)
      }
      // Setup is done: drop the root route's kept installation answer along with the draft.
      forgetInstallationStatus()
      onCompleted()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t("setup.error.generic")
      setError(message)
    } finally {
      setSubmitting(false)
    }
  }

  function handleNext() {
    setError(null)
    if (!currentStepValid) {
      setError(t("setup.error.requiredFields"))
      return
    }
    setStep((prev) => Math.min(4, prev + 1))
  }

  function handleOrganizationNameChange(value: string) {
    setSetupState((prev) => {
      const shouldUpdateSlug = !slugTouched
      return {
        ...prev,
        organizationName: value,
        organizationSlug: shouldUpdateSlug ? slugifyOrganizationName(value) : prev.organizationSlug,
      }
    })
  }

  return (
    <Card className="w-full max-w-3xl">
      <CardHeader>
        <CardTitle>{t("setup.title")}</CardTitle>
        {initialStatus.stage === "initialized" ? (
          <p className="text-sm text-muted-foreground">{t("setup.status.initialized")}</p>
        ) : (
          <p className="text-sm text-muted-foreground">{t("setup.subtitle")}</p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {step === 1 ? (
          <InstanceProfileStep
            value={setupState.instanceProfile}
            onChange={(instanceProfile) => setSetupState((prev) => ({ ...prev, instanceProfile }))}
          />
        ) : null}

        {step === 2 ? (
          <AdminOrgStep
            organizationName={setupState.organizationName}
            organizationSlug={setupState.organizationSlug}
            adminName={setupState.adminName}
            adminEmail={setupState.adminEmail}
            adminPassword={setupState.adminPassword}
            onOrganizationNameChange={handleOrganizationNameChange}
            onOrganizationSlugChange={(organizationSlug) => {
              setSlugTouched(true)
              setSetupState((prev) => ({ ...prev, organizationSlug }))
            }}
            onAdminNameChange={(adminName) => setSetupState((prev) => ({ ...prev, adminName }))}
            onAdminEmailChange={(adminEmail) => setSetupState((prev) => ({ ...prev, adminEmail }))}
            onAdminPasswordChange={(adminPassword) =>
              setSetupState((prev) => ({ ...prev, adminPassword }))
            }
          />
        ) : null}

        {step === 3 ? (
          <AuthConfigStep
            value={setupState.authMode}
            onChange={(authMode) => setSetupState((prev) => ({ ...prev, authMode }))}
          />
        ) : null}

        {step === 4 ? (
          <EmailFinishStep
            locale={setupState.locale}
            countryCode={setupState.countryCode}
            timezone={setupState.timezone}
            currency={setupState.currency}
            emailFromName={setupState.emailFromName}
            emailReplyTo={setupState.emailReplyTo}
            onLocaleChange={(locale) => setSetupState((prev) => ({ ...prev, locale }))}
            onCountryCodeChange={(countryCode) =>
              setSetupState((prev) => ({ ...prev, countryCode }))
            }
            onTimezoneChange={(timezone) => setSetupState((prev) => ({ ...prev, timezone }))}
            onCurrencyChange={(currency) => setSetupState((prev) => ({ ...prev, currency }))}
            onEmailFromNameChange={(emailFromName) =>
              setSetupState((prev) => ({ ...prev, emailFromName }))
            }
            onEmailReplyToChange={(emailReplyTo) =>
              setSetupState((prev) => ({ ...prev, emailReplyTo }))
            }
          />
        ) : null}
      </CardContent>

      <CardFooter className="flex justify-between">
        <Button
          type="button"
          variant="outline"
          onClick={() => setStep((prev) => Math.max(1, prev - 1))}
          disabled={step === 1 || submitting}
        >
          {t("setup.action.back")}
        </Button>

        {isLastStep ? (
          <Button type="button" onClick={handleFinish} disabled={!currentStepValid || submitting}>
            {submitting ? t("setup.action.completing") : t("setup.action.finish")}
          </Button>
        ) : (
          <Button type="button" onClick={handleNext} disabled={submitting}>
            {t("setup.action.next")}
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}
