import { Input } from "../../ui/input"
import { Label } from "../../ui/label"
import { useI18n } from "../../../lib/i18n/react"

type AdminOrgStepProps = {
  organizationName: string
  organizationSlug: string
  adminName: string
  adminEmail: string
  adminPassword: string
  onOrganizationNameChange: (value: string) => void
  onOrganizationSlugChange: (value: string) => void
  onAdminNameChange: (value: string) => void
  onAdminEmailChange: (value: string) => void
  onAdminPasswordChange: (value: string) => void
}

export function AdminOrgStep({
  organizationName,
  organizationSlug,
  adminName,
  adminEmail,
  adminPassword,
  onOrganizationNameChange,
  onOrganizationSlugChange,
  onAdminNameChange,
  onAdminEmailChange,
  onAdminPasswordChange,
}: AdminOrgStepProps) {
  const { t } = useI18n()

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold">{t("setup.step.adminOrg.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("setup.step.adminOrg.description")}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="setup-org-name">{t("setup.field.organizationName")}</Label>
          <Input
            id="setup-org-name"
            value={organizationName}
            onChange={(event) => onOrganizationNameChange(event.target.value)}
            placeholder={t("setup.placeholder.organizationName")}
            required
          />
        </div>

        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="setup-org-slug">{t("setup.field.organizationSlug")}</Label>
          <Input
            id="setup-org-slug"
            value={organizationSlug}
            onChange={(event) => onOrganizationSlugChange(event.target.value)}
            placeholder={t("setup.placeholder.organizationSlug")}
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="setup-admin-name">{t("setup.field.adminName")}</Label>
          <Input
            id="setup-admin-name"
            value={adminName}
            onChange={(event) => onAdminNameChange(event.target.value)}
            placeholder={t("setup.placeholder.adminName")}
            required
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="setup-admin-email">{t("setup.field.adminEmail")}</Label>
          <Input
            id="setup-admin-email"
            value={adminEmail}
            onChange={(event) => onAdminEmailChange(event.target.value)}
            placeholder={t("setup.placeholder.adminEmail")}
            type="email"
            required
          />
        </div>

        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="setup-admin-password">{t("setup.field.adminPassword")}</Label>
          <Input
            id="setup-admin-password"
            value={adminPassword}
            onChange={(event) => onAdminPasswordChange(event.target.value)}
            placeholder={t("setup.placeholder.adminPassword")}
            type="password"
            minLength={8}
            autoComplete="new-password"
            required
          />
        </div>
      </div>
    </div>
  )
}
