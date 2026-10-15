import { useI18n } from "../../lib/i18n/react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card"
import { Label } from "../ui/label"
import { Switch } from "../ui/switch"

/**
 * Hosted AI drafting: the runtime supplies the model, so the only choice is on or off.
 * The switch saves on its own through `onChange`; the page confirms the result.
 */
export function AiDraftsCard({
  enabled,
  busy = false,
  onChange,
}: {
  enabled: boolean
  busy?: boolean
  onChange: (enabled: boolean) => void
}) {
  const { t } = useI18n()
  return (
    <Card data-testid="ai-drafts-card">
      <CardHeader>
        <CardTitle>{t("settings.section.ai.title")}</CardTitle>
        <CardDescription>{t("settings.ai.drafts.help")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-3">
          <Switch id="aiDraftsEnabled" checked={enabled} disabled={busy} onCheckedChange={onChange} />
          <Label htmlFor="aiDraftsEnabled">{t("settings.ai.drafts.label")}</Label>
        </div>
      </CardContent>
    </Card>
  )
}
