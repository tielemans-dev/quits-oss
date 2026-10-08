import type { CommandConsequences } from "@quits/contracts/agent"
import { useI18n } from "../../lib/i18n/react"

export function ConsequenceReview({ consequences }: { consequences: CommandConsequences }) {
  const { t } = useI18n()
  return <section className="grid min-w-0 gap-2 rounded-md border p-3 text-sm [overflow-wrap:anywhere]" aria-label={t("agents.preview.title")}>
    <h3 className="font-medium">{t("agents.preview.title")}</h3>
    {consequences.records.some(record => record.kind === "invoice_issue") && <p>{t("agents.preview.invoiceIdentity")}</p>}
    <ul className="grid gap-1">
      {consequences.records.map(record => <li key={`${record.kind}:${record.documentId}`}>
        {t(`agents.preview.record.${record.kind}`)} · {record.documentId} · {t("agents.preview.revision")} {record.revision}
      </li>)}
      {consequences.messages.map(message => <li key={`${message.kind}:${message.recipient}`}>
        {t(`agents.preview.message.${message.kind}`)} · {message.recipient}
      </li>)}
    </ul>
    {!consequences.messages.length && <p>{t("agents.preview.noMessage")}</p>}
    {!!consequences.schedule?.length && <ul className="grid gap-1">
      {consequences.schedule.map(line => <li key={line.id}>
        {line.title} · {line.amount} {line.currency} · {t(`agents.preview.schedule.${line.kind}`)} · {t(`agents.preview.schedule.${line.state}`)}
        {line.kind === "prepayment" && line.state === "draft" ? ` · ${t("agents.preview.manual.prepayment_blocked")}` : ""}
        {line.invoiceId ? ` · ${line.invoiceId}` : ""}
      </li>)}
    </ul>}
    <ul className="grid gap-1 text-muted-foreground">
      {consequences.manualSteps.map(step => <li key={step}>{t(`agents.preview.manual.${step}`)}</li>)}
    </ul>
    <p className="text-muted-foreground">{t(`agents.preview.refresh.${consequences.refreshWhen}`)}</p>
  </section>
}
