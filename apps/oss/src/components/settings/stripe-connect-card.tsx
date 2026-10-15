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
 * Hosted Connect status from settings. Actions stay disabled until the page passes a
 * handler registered by the runtime. This card does not call Stripe.
 */
export function StripeConnectCard({
  account,
  paymentsEnabled = false,
  onConnect,
  onResume,
  onFixInStripe,
  onDisconnect,
}: {
  account: Pick<OrgStripeAccount, "accountId" | "status">
  paymentsEnabled?: boolean
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
        <p className="text-sm text-muted-foreground">
          {t(paymentsEnabled && status === "active"
            ? "settings.payments.connect.payments.enabled"
            : "settings.payments.connect.payments.unavailable")}
        </p>
        {status !== "none" && accountId ? (
          <div className="grid gap-1">
            <div className="text-sm font-medium">{t("settings.payments.connect.account.label")}</div>
            <div className="text-sm text-muted-foreground">{accountId}</div>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {status === "none" ? (
            <Button type="button" disabled={!onConnect} onClick={onConnect}>
              {t("settings.payments.connect.action.connect")}
            </Button>
          ) : null}
          {status === "pending" ? (
            <Button type="button" disabled={!onResume} onClick={onResume}>
              {t("settings.payments.connect.action.resume")}
            </Button>
          ) : null}
          {status === "restricted" ? (
            <Button type="button" disabled={!onFixInStripe} onClick={onFixInStripe}>
              {t("settings.payments.connect.action.fix")}
            </Button>
          ) : null}
          {status !== "none" ? (
            onDisconnect ? (
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
                    <AlertDialogAction type="button" variant="destructive" onClick={onDisconnect}>
                      {t("settings.payments.connect.disconnect.confirm")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : (
              <Button type="button" variant="outline" disabled>
                {t("settings.payments.connect.action.disconnect")}
              </Button>
            )
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}
