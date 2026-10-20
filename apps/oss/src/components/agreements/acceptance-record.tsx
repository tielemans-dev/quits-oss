import type { PublicAgreementDto } from "../../lib/agreements/public"
import { formatDateTime } from "../../lib/i18n/format"
import { useI18n } from "../../lib/i18n/react"
/** The moment is shown in the agreement's time zone; Danish time when none is known. */
export function AcceptanceRecord({ record, timeZone }: { record: PublicAgreementDto["acceptance"]; timeZone?: string | null }) {
  const { t, locale } = useI18n()
  if (!record) return null
  return (
    <section className="rounded-md border p-4 grid min-w-0 gap-2 [overflow-wrap:anywhere]">
      <h2 className="font-semibold">{t("agreements.acceptanceRecord")}</h2>
      <p>
        {t("agreements.acceptedBy")}: {record.name}
      </p>
      <p>
        {t("agreements.recipient")}: {record.intendedRecipient ?? t("agreements.unspecified")}
      </p>
      <p>
        {t("agreements.acceptedAt")}: {formatDateTime(record.at, locale, timeZone || "Europe/Copenhagen")}
      </p>
      <p>
        {t("agreements.method")}:{" "}
        {t(
          record.method === "customer_link"
            ? "agreements.customerLinkMethod"
            : "agreements.internalMethod",
        )}
      </p>
      <p>
        {t("agreements.revision")}: {record.revision}
      </p>
      <p className="text-sm text-muted-foreground">{t("agreements.identityNotice")}</p>
      {/* Evidence of exactly what was accepted: kept in full, but out of the reading flow. */}
      {record.hash && <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">
          {t("agreements.hash")}: <span className="font-mono">{record.hash.slice(0, 12)}…</span>
        </summary>
        <p className="mt-1 font-mono break-all">{record.hash}</p>
      </details>}
    </section>
  )
}
