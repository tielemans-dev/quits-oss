import { useI18n } from "../../lib/i18n/react"

export function B2bNotice({ className }: { className?: string }) {
  const { t } = useI18n()
  return <p className={className}>{t("auth.onboarding.b2bOnly")}. {t("auth.onboarding.cvrFree")}</p>
}
