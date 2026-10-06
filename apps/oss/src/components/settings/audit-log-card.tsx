import { History } from "lucide-react"
import { useI18n } from "../../lib/i18n/react"
import { cn } from "../../lib/utils"
import { buttonVariants } from "../ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card"

/** Points to the organization audit log and accounting export on the activity page. */
export function AuditLogCard() {
  const { t } = useI18n()
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("activity.settings.title")}</CardTitle>
        <CardDescription>{t("activity.settings.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {/* A plain link keeps this card independent of router mocks in settings page tests. */}
        <a href="/activity" className={cn(buttonVariants({ variant: "outline" }))}>
          <History className="size-4" />
          {t("activity.settings.open")}
        </a>
      </CardContent>
    </Card>
  )
}
