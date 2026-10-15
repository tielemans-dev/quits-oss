import type { ReactNode } from "react"
import type { OrgStripeAccount, StripePaymentMode } from "@quits/contracts/payments"
import {
  followStripeConnectUrl,
  stripeConnectRedirectUrl,
  type StripeConnectSettingsAction,
} from "../../lib/runtime/stripe-connect-settings"
import { useI18n } from "../../lib/i18n/react"
import { trpc } from "../../trpc/client"
import { StripeConnectCard } from "./stripe-connect-card"
import { Button } from "../ui/button"

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
  if (input.mode === "connect") return {
    clearStripeSecretKey: input.clearStripeSecretKey,
    clearStripeWebhookSecret: input.clearStripeWebhookSecret,
  }
  return {
    stripePublishableKey: input.stripePublishableKey || undefined,
    stripeSecretKey: input.stripeSecretKey || undefined,
    stripeWebhookSecret: input.stripeWebhookSecret || undefined,
    clearStripeSecretKey: input.clearStripeSecretKey,
    clearStripeWebhookSecret: input.clearStripeWebhookSecret,
  }
}

export function StripePaymentsSection({
  account,
  children,
  stripeByokConfigured,
  stripePaymentsEnabled = false,
  clearStripeSecretKey,
  clearStripeWebhookSecret,
  onClearStripeSecretKeyChange,
  onClearStripeWebhookSecretChange,
  connectActions = false,
  onConnectSettings,
  onConnectError,
}: {
  children?: ReactNode
  account?: OrgStripeAccount
  stripeByokConfigured: boolean
  stripePaymentsEnabled?: boolean
  clearStripeSecretKey: boolean
  clearStripeWebhookSecret: boolean
  onClearStripeSecretKeyChange: (clear: boolean) => void
  onClearStripeWebhookSecretChange: (clear: boolean) => void
  /** True only when a runtime handler is registered and the caller may update settings. */
  connectActions?: boolean
  onConnectSettings?: (next: { stripeAccount: OrgStripeAccount; stripeConnectActions: boolean; stripePaymentsEnabled: boolean; stripeByokConfigured: boolean; stripeCheckoutKind: "byok" | "connect" | null }) => void
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
      onConnectSettings?.(next)
    } catch (err) {
      onConnectError?.(err instanceof Error ? err.message : t("settings.error.saveFailed"))
    }
  }

  if (account?.mode !== "connect") return children
  const removing = clearStripeSecretKey && clearStripeWebhookSecret
  return (
    <div className="grid gap-4">
      <StripeConnectCard
        account={account}
        paymentsEnabled={stripePaymentsEnabled}
        {...stripeConnectActionHandlers(connectActions, (action) => { void runConnectAction(action) })}
      />
      {stripeByokConfigured ? (
        <div className="grid gap-2 rounded-lg border p-4" role="status">
          <p className="text-sm">{t(removing ? "settings.payments.connect.legacy.removing" : "settings.payments.connect.legacy.active")}</p>
          <Button type="button" variant="outline" className="justify-self-start" onClick={() => {
            onClearStripeSecretKeyChange(!removing)
            onClearStripeWebhookSecretChange(!removing)
          }}>
            {t(removing ? "settings.payments.undo" : "settings.payments.connect.legacy.remove")}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
