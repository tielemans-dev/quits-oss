import type { OrgStripeAccount, StripeAccountStatus } from "@quits/contracts/payments"
import { useI18n } from "../../lib/i18n/react"
import type { TranslationKey } from "../../lib/i18n/messages"
import { StatusBadge } from "../status-badge"
import { Button } from "../ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../ui/alert-dialog"

const HELP_KEYS = {
  none: "settings.payments.connect.help.none",
  pending: "settings.payments.connect.help.pending",
  active: "settings.payments.connect.help.active",
  restricted: "settings.payments.connect.help.restricted",
} as const satisfies Record<StripeAccountStatus, TranslationKey>

/**
 * Hosted Connect status from settings. Account Links and disconnect run in the hosted
 * runtime; this card only shows `stripeAccount` and calls the handlers it is given.
 */
export function StripeConnectCard({
  account,
  onConnect,
  onResume,
  onFixInStripe,
  onDisconnect,
}: {
  account: Pick<OrgStripeAccount, "accountId" | "status">
  onConnect?: () => void
  onResume?: () => void
  onFixInStripe?: () => void
  onDisconnect?: () => void
}) {
  const { t } = useI18n()
  const { status, accountId } = account

  return (
    <Card data-testid="stripe-connect-card" data-stripe-connect-status={status}>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle>{t("settings.payments.connect.title")}</CardTitle>
            <CardDescription>{t("settings.payments.connect.description")}</CardDescription>
          </div>
          <StatusBadge domain="stripeAccount" status={status} />
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-sm text-muted-foreground">{t(HELP_KEYS[status])}</p>
        {status !== "none" && accountId ? (
          <div className="grid gap-1">
            <div className="text-sm font-medium">{t("settings.payments.connect.account.label")}</div>
            <div className="text-sm text-muted-foreground">{accountId}</div>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {status === "none" ? (
            <Button type="button" onClick={onConnect}>
              {t("settings.payments.connect.action.connect")}
            </Button>
          ) : null}
          {status === "pending" ? (
            <Button type="button" onClick={onResume}>
              {t("settings.payments.connect.action.resume")}
            </Button>
          ) : null}
          {status === "restricted" ? (
            <Button type="button" onClick={onFixInStripe}>
              {t("settings.payments.connect.action.fix")}
            </Button>
          ) : null}
          {status !== "none" ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type="button" variant="outline">
                  {t("settings.payments.connect.action.disconnect")}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("settings.payments.connect.disconnect.title")}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("settings.payments.connect.disconnect.description")}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel type="button">
                    {t("settings.payments.connect.disconnect.cancel")}
                  </AlertDialogCancel>
                  <AlertDialogAction type="button" variant="destructive" onClick={() => onDisconnect?.()}>
                    {t("settings.payments.connect.disconnect.confirm")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}
