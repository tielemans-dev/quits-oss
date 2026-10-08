import type { EmailDeliveryRuntimeStatus } from "../../lib/email-delivery"
import { useI18n } from "../../lib/i18n/react"
import { StatusBadge } from "../status-badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card"

export function EmailDeliveryCard({
  emailDelivery,
}: {
  emailDelivery: EmailDeliveryRuntimeStatus
}) {
  const { t } = useI18n()

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle>{t("settings.section.emailDelivery.title")}</CardTitle>
            <CardDescription>
              {t("settings.section.emailDelivery.description")}
            </CardDescription>
          </div>
          <StatusBadge domain="emailSetup" status={emailDelivery.status} />
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-1">
          <div className="text-sm font-medium">
            {t("settings.emailDelivery.sender.label")}
          </div>
          <div className="text-sm text-muted-foreground">{emailDelivery.sender}</div>
        </div>

        {emailDelivery.missing.length > 0 && (
          <div className="grid gap-1">
            <div className="text-sm font-medium">
              {t("settings.emailDelivery.missing.label")}
            </div>
            <div className="text-sm text-muted-foreground">
              {emailDelivery.missing.join(", ")}
            </div>
          </div>
        )}

        <p className="text-sm text-muted-foreground">
          {t(`settings.emailDelivery.help.${emailDelivery.status}`)}
        </p>
      </CardContent>
    </Card>
  )
}
