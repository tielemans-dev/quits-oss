import type { ReactNode } from "react"
import { getStatusTone } from "../../lib/status-tones"
import { ToneBadge } from "../status-badge"
import { Button } from "../ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card"
import { Input } from "../ui/input"
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

export type EmailDeliveryPanelStatus = {
  /** The outcome of the last attempt; its tone comes from `statusTones.emailDelivery`. */
  outcome: "sent" | "skipped" | "failed" | "sending" | "unconfirmed"
  label: string
  detail: string
  message?: string | null
}

export type EmailDeliveryPanelAction = {
  label: string
  pendingLabel: string
  pending: boolean
  disabled?: boolean
  onClick: () => void
}

export type EmailDeliveryPanelDegradedAction = {
  open: boolean
  triggerLabel: string
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  pending: boolean
  onConfirm: () => void
  onOpenChange: (open: boolean) => void
}

export type EmailDeliveryPanelPublicLink = {
  title: string
  description: string
  url: string
  copyLabel: string
  onCopy?: () => void
  footer?: ReactNode
}

export type EmailDeliveryPanelFallback = {
  title: string
  description: string
  copyLabel?: string
  onCopy?: () => void
  fixAction?: ReactNode
}

export function EmailDeliveryPanel({
  title,
  description,
  status,
  action,
  degradedAction,
  fallback,
  publicLink,
  className,
}: {
  title: string
  description: string
  status?: EmailDeliveryPanelStatus | null
  action?: EmailDeliveryPanelAction | null
  degradedAction?: EmailDeliveryPanelDegradedAction | null
  fallback?: EmailDeliveryPanelFallback | null
  publicLink?: EmailDeliveryPanelPublicLink | null
  className?: string
}) {
  return (
    <Card className={className}>
      <CardHeader className="gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          {status ? (
            <ToneBadge tone={getStatusTone("emailDelivery", status.outcome)}>
              {status.label}
            </ToneBadge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        {status ? (
          <div className="rounded-md border p-4">
            <p className="text-sm font-medium">{status.detail}</p>
            {status.message ? (
              <p className="mt-1 text-sm text-muted-foreground">{status.message}</p>
            ) : null}
          </div>
        ) : null}

        {action ? (
          <div className="flex flex-wrap gap-2">
            <Button disabled={action.disabled || action.pending} onClick={action.onClick}>
              {action.pending ? action.pendingLabel : action.label}
            </Button>
          </div>
        ) : null}

        {degradedAction ? (
          <AlertDialog open={degradedAction.open} onOpenChange={degradedAction.onOpenChange}>
            <AlertDialogTrigger asChild>
              <Button disabled={degradedAction.pending}>{degradedAction.triggerLabel}</Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{degradedAction.title}</AlertDialogTitle>
                <AlertDialogDescription>{degradedAction.description}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{degradedAction.cancelLabel}</AlertDialogCancel>
                <AlertDialogAction onClick={degradedAction.onConfirm}>
                  {degradedAction.pending
                    ? degradedAction.confirmLabel
                    : degradedAction.confirmLabel}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}

        {fallback ? (
          <div className="grid gap-3 rounded-md border border-dashed p-4">
            <div>
              <h3 className="text-sm font-medium">{fallback.title}</h3>
              <p className="text-sm text-muted-foreground">{fallback.description}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {fallback.fixAction}
              {fallback.copyLabel && fallback.onCopy ? (
                <Button type="button" variant="outline" onClick={fallback.onCopy}>
                  {fallback.copyLabel}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {publicLink ? (
          <div className="grid gap-2 rounded-md border p-4">
            <div>
              <h3 className="text-sm font-medium">{publicLink.title}</h3>
              <p className="text-sm text-muted-foreground">{publicLink.description}</p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input readOnly value={publicLink.url} />
              {publicLink.onCopy ? (
                <Button type="button" variant="outline" onClick={publicLink.onCopy}>
                  {publicLink.copyLabel}
                </Button>
              ) : null}
            </div>
            {publicLink.footer ? (
              <div className="text-sm text-muted-foreground">{publicLink.footer}</div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
