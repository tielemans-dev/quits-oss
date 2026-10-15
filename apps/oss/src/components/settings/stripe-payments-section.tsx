import type { OrgStripeAccount, StripePaymentMode } from "@quits/contracts/payments"
import {
  followStripeConnectUrl,
  stripeConnectRedirectUrl,
  type StripeConnectSettingsAction,
} from "../../lib/runtime/stripe-connect-settings"
import { useI18n } from "../../lib/i18n/react"
import { trpc } from "../../trpc/client"
import { Button } from "../ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card"
import { Input } from "../ui/input"
import { Label } from "../ui/label"
import { StripeConnectCard } from "./stripe-connect-card"

const BYOK_ACCOUNT: OrgStripeAccount = {
  mode: "byok",
  accountId: null,
  status: "none",
  statusAt: null,
}

/** Handlers for the Connect card. Empty until a runtime handler is registered. */
export function stripeConnectActionHandlers(
  registered: boolean | undefined,
  run: (action: StripeConnectSettingsAction) => void,
): {
  onConnect?: () => void
  onResume?: () => void
  onFixInStripe?: () => void
  onDisconnect?: () => void
} {
  if (!registered) return {}
  return {
    onConnect: () => run("connect"),
    onResume: () => run("resume"),
    onFixInStripe: () => run("fix"),
    onDisconnect: () => run("disconnect"),
  }
}

/** Stripe key fields for a settings save. Managed Connect omits them so raw keys are not written. */
export function stripeByokUpdate(input: {
  mode: StripePaymentMode | undefined
  stripePublishableKey: string
  stripeSecretKey: string
  stripeWebhookSecret: string
  clearStripeSecretKey: boolean
  clearStripeWebhookSecret: boolean
}) {
  if (input.mode === "connect") return {}
  return {
    stripePublishableKey: input.stripePublishableKey || undefined,
    stripeSecretKey: input.stripeSecretKey || undefined,
    stripeWebhookSecret: input.stripeWebhookSecret || undefined,
    clearStripeSecretKey: input.clearStripeSecretKey,
    clearStripeWebhookSecret: input.clearStripeWebhookSecret,
  }
}

/**
 * Hosted installs (`stripeAccount.mode === "connect"`, from `payments.managed`) show Connect
 * status. Self-hosted installs keep the raw key form.
 */
export function StripePaymentsSection({
  account = BYOK_ACCOUNT,
  stripeByokConfigured,
  stripePublishableKey,
  clearStripeSecretKey,
  clearStripeWebhookSecret,
  onClearStripeSecretKeyChange,
  onClearStripeWebhookSecretChange,
  connectActions = false,
  onConnectSettings,
  onConnectError,
}: {
  account?: OrgStripeAccount
  stripeByokConfigured: boolean
  stripePublishableKey: string | null
  clearStripeSecretKey: boolean
  clearStripeWebhookSecret: boolean
  onClearStripeSecretKeyChange: (clear: boolean) => void
  onClearStripeWebhookSecretChange: (clear: boolean) => void
  /** True only when a runtime handler is registered and the caller may update settings. */
  connectActions?: boolean
  onConnectSettings?: (next: { stripeAccount: OrgStripeAccount; stripeConnectActions: boolean }) => void
  onConnectError?: (message: string | null) => void
}) {
  const { t } = useI18n()

  async function runConnectAction(action: StripeConnectSettingsAction) {
    onConnectError?.(null)
    try {
      const result = await trpc.settings.runStripeConnectAction.mutate({ action })
      const url = stripeConnectRedirectUrl(result.url)
      if (url) {
        followStripeConnectUrl(url)
        return
      }
      const next = await trpc.settings.get.query()
      onConnectSettings?.({
        stripeAccount: next.stripeAccount,
        stripeConnectActions: next.stripeConnectActions,
      })
    } catch (err) {
      onConnectError?.(err instanceof Error ? err.message : t("settings.error.saveFailed"))
    }
  }

  if (account.mode === "connect") {
    return (
      <StripeConnectCard
        account={account}
        {...stripeConnectActionHandlers(connectActions, (action) => {
          void runConnectAction(action)
        })}
      />
    )
  }

  return (
    <Card data-testid="stripe-byok-form">
      <CardHeader>
        <CardTitle>{t("settings.section.payments.title")}</CardTitle>
        <CardDescription>
          {t("settings.section.payments.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="stripePublishableKey">{t("settings.payments.stripePublishableKey.label")}</Label>
          <Input
            id="stripePublishableKey"
            name="stripePublishableKey"
            autoComplete="off"
            placeholder="pk_test_..."
            defaultValue={stripePublishableKey ?? ""}
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="stripeSecretKey">{t("settings.payments.stripeSecretKey.label")}</Label>
          <Input
            id="stripeSecretKey"
            name="stripeSecretKey"
            type="password"
            autoComplete="off"
            placeholder="sk_test_..."
            onChange={() => onClearStripeSecretKeyChange(false)}
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="stripeWebhookSecret">{t("settings.payments.stripeWebhookSecret.label")}</Label>
          <Input
            id="stripeWebhookSecret"
            name="stripeWebhookSecret"
            type="password"
            autoComplete="off"
            placeholder="whsec_..."
            onChange={() => onClearStripeWebhookSecretChange(false)}
          />
          <p className="text-xs text-muted-foreground">
            {stripeByokConfigured
              ? t("settings.payments.configuredHelp")
              : t("settings.payments.notConfiguredHelp")}
          </p>
        </div>

        {stripeByokConfigured && (
          <div className="flex flex-wrap items-center gap-2">
            {!clearStripeSecretKey ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onClearStripeSecretKeyChange(true)}
              >
                {t("settings.payments.removeSecret")}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onClearStripeSecretKeyChange(false)}
              >
                {t("settings.payments.undo")}
              </Button>
            )}

            {!clearStripeWebhookSecret ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onClearStripeWebhookSecretChange(true)}
              >
                {t("settings.payments.removeWebhook")}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onClearStripeWebhookSecretChange(false)}
              >
                {t("settings.payments.undo")}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
