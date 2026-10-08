import { useI18n } from "../../lib/i18n/react"
import { StatusBadge } from "../status-badge"
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

export type DocumentSenderPreview = {
  fromName: string
  fromEmail: string
  replyTo: string | null
  usingBrandedDomain: boolean
}

export type DocumentSendingStatus =
  | "not_configured"
  | "pending_dns"
  | "verifying"
  | "verified"
  | "failed"

export type DocumentSendingSyncSource = "manual" | "webhook"

export type DocumentSendingState = {
  managed: boolean
  supportsCustomDomain: boolean
  status: DocumentSendingStatus
  requestedDomain: string | null
  records: {
    name: string
    type: string
    value: string
    ttl?: number | null
    status?: string | null
  }[]
  failureReason: string | null
  verifiedAt: Date | null
  lastSyncedAt: Date | null
  lastSyncSource: DocumentSendingSyncSource | null
  sharedSender: DocumentSenderPreview
  effectiveSender: DocumentSenderPreview
}

function SenderPreview({
  label,
  replyToLabel,
  sender,
}: {
  label: string
  replyToLabel: string
  sender: DocumentSenderPreview
}) {
  return (
    <div className="grid gap-1">
      <div className="text-sm font-medium">{label}</div>
      <div className="text-sm text-muted-foreground">
        {sender.fromName} &lt;{sender.fromEmail}&gt;
      </div>
      {sender.replyTo ? (
        <div className="text-xs text-muted-foreground">
          {replyToLabel}: {sender.replyTo}
        </div>
      ) : null}
    </div>
  )
}

export function DocumentEmailSendingCard({
  documentSending,
  requestedDomain,
  busy,
  error,
  success,
  onRequestedDomainChange,
  onConfigure,
  onRefresh,
  onDisable,
}: {
  documentSending: DocumentSendingState
  requestedDomain: string
  busy: boolean
  error: string | null
  success: string | null
  onRequestedDomainChange: (value: string) => void
  onConfigure: () => void
  onRefresh: () => void
  onDisable: () => void
}) {
  const { t } = useI18n()

  if (!documentSending.supportsCustomDomain) {
    return null
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle>{t("settings.section.documentSending.title")}</CardTitle>
            <CardDescription>
              {t("settings.section.documentSending.description")}
            </CardDescription>
          </div>
          <StatusBadge domain="documentSending" status={documentSending.status} />
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        <SenderPreview
          label={t("settings.documentSending.effectiveSender.label")}
          replyToLabel={t("settings.documentSending.replyTo.label")}
          sender={documentSending.effectiveSender}
        />
        <SenderPreview
          label={t("settings.documentSending.sharedSender.label")}
          replyToLabel={t("settings.documentSending.replyTo.label")}
          sender={documentSending.sharedSender}
        />

        {documentSending.status === "not_configured" ? (
          <div className="grid gap-2">
            <Label htmlFor="documentSendingDomain">
              {t("settings.documentSending.domain.label")}
            </Label>
            <Input
              id="documentSendingDomain"
              value={requestedDomain}
              onChange={(event) => onRequestedDomainChange(event.target.value)}
              placeholder="billing.acme.com"
            />
            <p className="text-xs text-muted-foreground">
              {t("settings.documentSending.domain.help")}
            </p>
            <div>
              <Button
                type="button"
                onClick={onConfigure}
                disabled={busy || requestedDomain.trim().length === 0}
              >
                {t("settings.documentSending.actions.configure")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="grid gap-1">
              <div className="text-sm font-medium">
                {t("settings.documentSending.requestedDomain.label")}
              </div>
              <div className="text-sm text-muted-foreground">
                {documentSending.requestedDomain}
              </div>
            </div>

            {documentSending.records.length > 0 ? (
              <div className="grid gap-2">
                <div className="text-sm font-medium">
                  {t("settings.documentSending.records.label")}
                </div>
                <div className="grid gap-2 rounded-md border p-3">
                  {documentSending.records.map((record) => (
                    <div key={`${record.type}:${record.name}:${record.value}`} className="grid gap-1 text-sm">
                      <div className="font-medium">
                        {record.type} {record.name}
                      </div>
                      <div className="text-muted-foreground break-all">{record.value}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {documentSending.failureReason ? (
              <div className="grid gap-1">
                <div className="text-sm font-medium">
                  {t("settings.documentSending.failureReason.label")}
                </div>
                <div className="text-sm text-muted-foreground">
                  {documentSending.failureReason}
                </div>
              </div>
            ) : null}

            {documentSending.verifiedAt ? (
              <div className="grid gap-1">
                <div className="text-sm font-medium">
                  {t("settings.documentSending.verifiedAt.label")}
                </div>
                <div className="text-sm text-muted-foreground">
                  {documentSending.verifiedAt.toISOString()}
                </div>
              </div>
            ) : null}

            {documentSending.lastSyncedAt ? (
              <div className="grid gap-1">
                <div className="text-sm font-medium">
                  {t("settings.documentSending.lastSyncedAt.label")}
                </div>
                <div className="text-sm text-muted-foreground">
                  {documentSending.lastSyncedAt.toISOString()}
                </div>
              </div>
            ) : null}

            {documentSending.lastSyncSource ? (
              <div className="grid gap-1">
                <div className="text-sm font-medium">
                  {t("settings.documentSending.lastSyncSource.label")}
                </div>
                <div className="text-sm text-muted-foreground">
                  {t(
                    `settings.documentSending.lastSyncSource.${documentSending.lastSyncSource}`
                  )}
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={onRefresh} disabled={busy}>
                {t("settings.documentSending.actions.refresh")}
              </Button>
              <Button type="button" variant="outline" onClick={onDisable} disabled={busy}>
                {t("settings.documentSending.actions.disable")}
              </Button>
            </div>
          </>
        )}

        {error ? <p className="text-sm text-tone-danger">{error}</p> : null}
        {success ? <p className="text-sm text-tone-success">{success}</p> : null}
      </CardContent>
    </Card>
  )
}
