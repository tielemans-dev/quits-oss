import { Fragment, useState } from "react"
import { Bot } from "lucide-react"
import type { TranslationKey } from "../../lib/i18n/messages"
import { useI18n } from "../../lib/i18n/react"
import { trpc } from "../../trpc/client"
import { Badge } from "../ui/badge"
import { Button } from "../ui/button"
import { Card, CardContent } from "../ui/card"
import { Textarea } from "../ui/textarea"
import { formatDateTime } from "./format"
import type { ApprovalRow, DecisionRecord } from "./types"

/** Labels for the document facts a command records for its approver. */
const reviewLabelKeys: Partial<Record<string, TranslationKey>> = {
  number: "agents.approvals.review.number",
  customer: "agents.approvals.review.customer",
  recipient: "agents.approvals.review.recipient",
  total: "agents.approvals.review.total",
  amount: "agents.approvals.review.amount",
  currency: "agents.approvals.review.currency",
  dueDate: "agents.approvals.review.dueDate",
  expiryDate: "agents.approvals.review.expiryDate",
  reason: "agents.approvals.review.reason",
}

const statusVariant = {
  pending: "outline",
  approved: "secondary",
  rejected: "destructive",
  expired: "outline",
} as const

type ApprovalStatus = keyof typeof statusVariant

function DecisionResult({ record }: { record: DecisionRecord }) {
  const { t } = useI18n()
  const message =
    record.status === "failed"
      ? t("agents.approvals.result.failed", { message: record.error?.message ?? "" })
      : t(`agents.approvals.result.${record.status}`)
  return (
    <p className={`text-sm ${record.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
      {message}
    </p>
  )
}

/** One approval request: what the agent wants to do and, while pending, the decision controls. */
export function ApprovalItem({
  approval,
  onDecided,
}: {
  approval: ApprovalRow
  onDecided?: (record: DecisionRecord) => void
}) {
  const { t, locale } = useI18n()
  const [note, setNote] = useState("")
  const [deciding, setDeciding] = useState<"approve" | "reject" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<DecisionRecord | null>(null)
  const status = approval.status as ApprovalStatus
  const isPending = status === "pending" && !result

  async function decide(decision: "approve" | "reject") {
    setDeciding(decision)
    setError(null)
    try {
      const record = await trpc.agents.decide.mutate({
        approvalRequestId: approval.id,
        decision,
        note: note.trim() || undefined,
      })
      setResult(record)
      onDecided?.(record)
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : t("agents.approvals.error.decide"))
    } finally {
      setDeciding(null)
    }
  }

  const reviewLabel = (key: string) => {
    const labelKey = reviewLabelKeys[key]
    return labelKey ? t(labelKey) : key
  }

  return (
    <Card className="py-4">
      <CardContent className="grid gap-3 px-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="grid gap-1">
            <div className="font-medium">{approval.summary}</div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Bot className="size-3.5" />
                {approval.agent.name}
                <span className="font-mono">({approval.agent.displayPrefix}…)</span>
              </span>
              {approval.agent.revokedAt ? (
                <Badge variant="outline">{t("agents.approvals.keyRevoked")}</Badge>
              ) : null}
              <span className="font-mono">{approval.commandType}</span>
            </div>
          </div>
          <Badge variant={statusVariant[status] ?? "outline"}>
            {t(`agents.approvals.status.${status}`)}
          </Badge>
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{t("agents.approvals.requested", { date: formatDateTime(approval.createdAt, locale) })}</span>
          {status === "pending" ? (
            <span>{t("agents.approvals.expires", { date: formatDateTime(approval.expiresAt, locale) })}</span>
          ) : null}
          {approval.decidedAt ? (
            <span>
              {t("agents.approvals.decided", { date: formatDateTime(approval.decidedAt, locale) })}
              {approval.decidedByName
                ? ` ${t("agents.approvals.decidedBy", { name: approval.decidedByName })}`
                : ""}
            </span>
          ) : null}
          {status !== "pending" && approval.commandStatus ? (
            <span>
              {t("agents.approvals.commandStatus", {
                status: t(`agents.approvals.commandStatus.${approval.commandStatus}`),
              })}
            </span>
          ) : null}
        </div>

        {approval.reviewDetails ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border px-3 py-2 text-sm">
            {Object.entries(approval.reviewDetails).map(([key, value]) => (
              <Fragment key={key}>
                <dt className="text-muted-foreground">{reviewLabel(key)}</dt>
                <dd className="font-medium">{value ?? "—"}</dd>
              </Fragment>
            ))}
          </dl>
        ) : null}

        {approval.decisionNote ? (
          <p className="text-sm">
            <span className="font-medium">{t("agents.approvals.note")}:</span> {approval.decisionNote}
          </p>
        ) : null}
        {status !== "pending" && approval.commandStatus === "failed" && approval.commandError ? (
          <p className="text-sm text-destructive">{approval.commandError}</p>
        ) : null}

        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">{t("agents.approvals.details")}</summary>
          <pre className="mt-2 overflow-x-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs">
            {JSON.stringify(approval.command, null, 2)}
          </pre>
        </details>

        {isPending ? (
          approval.canDecide ? (
            <div className="grid gap-2">
              <Textarea
                value={note}
                maxLength={1000}
                rows={2}
                aria-label={t("agents.approvals.note")}
                placeholder={t("agents.approvals.notePlaceholder")}
                onChange={(event) => setNote(event.target.value)}
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={deciding !== null}
                  onClick={() => void decide("reject")}
                >
                  {deciding === "reject" ? t("agents.approvals.deciding") : t("agents.approvals.reject")}
                </Button>
                <Button size="sm" disabled={deciding !== null} onClick={() => void decide("approve")}>
                  {deciding === "approve" ? t("agents.approvals.deciding") : t("agents.approvals.approve")}
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("agents.approvals.noPermission", { permission: approval.requiredPermission ?? "" })}
            </p>
          )
        ) : null}

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {result ? <DecisionResult record={result} /> : null}
      </CardContent>
    </Card>
  )
}
