import { cn } from "../../../lib/utils"
import { useI18n } from "../../../lib/i18n/react"
import type { SetupWizardState } from "../types"

type InstanceProfile = SetupWizardState["instanceProfile"]

type InstanceProfileStepProps = {
  value: InstanceProfile
  onChange: (next: InstanceProfile) => void
}

const profileOptions: InstanceProfile[] = ["freelancer", "smb", "enterprise"]
const titleKeys: Record<
  InstanceProfile,
  "setup.instanceProfile.freelancer.title" | "setup.instanceProfile.smb.title" | "setup.instanceProfile.enterprise.title"
> = {
  freelancer: "setup.instanceProfile.freelancer.title",
  smb: "setup.instanceProfile.smb.title",
  enterprise: "setup.instanceProfile.enterprise.title",
}
const descriptionKeys: Record<
  InstanceProfile,
  | "setup.instanceProfile.freelancer.description"
  | "setup.instanceProfile.smb.description"
  | "setup.instanceProfile.enterprise.description"
> = {
  freelancer: "setup.instanceProfile.freelancer.description",
  smb: "setup.instanceProfile.smb.description",
  enterprise: "setup.instanceProfile.enterprise.description",
}

export function InstanceProfileStep({ value, onChange }: InstanceProfileStepProps) {
  const { t } = useI18n()

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold">{t("setup.step.instanceProfile.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("setup.step.instanceProfile.description")}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {profileOptions.map((option) => {
          const isSelected = value === option
          return (
            <button
              key={option}
              type="button"
              aria-pressed={isSelected}
              className={cn(
                "rounded-lg border p-4 text-left transition-colors",
                isSelected
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/40"
              )}
              onClick={() => onChange(option)}
            >
              <p className="font-medium">{t(titleKeys[option])}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t(descriptionKeys[option])}
              </p>
            </button>
          )
        })}
      </div>
    </div>
  )
}
