import { cn } from "../../../lib/utils"
import { useI18n } from "../../../lib/i18n/react"
import type { SetupWizardState } from "../types"

type AuthMode = SetupWizardState["authMode"]

type AuthConfigStepProps = {
  value: AuthMode
  onChange: (next: AuthMode) => void
}

const authModes: Array<{
  value: AuthMode
  titleKey: "setup.auth.localOnly.title" | "setup.auth.localPlusOauth.title"
  descriptionKey: "setup.auth.localOnly.description" | "setup.auth.localPlusOauth.description"
}> = [
  {
    value: "local_only",
    titleKey: "setup.auth.localOnly.title",
    descriptionKey: "setup.auth.localOnly.description",
  },
  {
    value: "local_plus_oauth",
    titleKey: "setup.auth.localPlusOauth.title",
    descriptionKey: "setup.auth.localPlusOauth.description",
  },
]

export function AuthConfigStep({ value, onChange }: AuthConfigStepProps) {
  const { t } = useI18n()

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold">{t("setup.step.auth.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("setup.step.auth.description")}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {authModes.map((option) => {
          const isSelected = value === option.value
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={isSelected}
              className={cn(
                "rounded-lg border p-4 text-left transition-colors",
                isSelected
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/40"
              )}
              onClick={() => onChange(option.value)}
            >
              <p className="font-medium">{t(option.titleKey)}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t(option.descriptionKey)}</p>
            </button>
          )
        })}
      </div>
    </div>
  )
}
