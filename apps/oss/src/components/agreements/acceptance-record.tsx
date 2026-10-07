import type { PublicAgreementDto } from "../../lib/agreements/public"
import { useI18n } from "../../lib/i18n/react"
export function AcceptanceRecord({ record }: { record: PublicAgreementDto["acceptance"] }) {
  const { t } = useI18n()
  if (!record) return null
  return (
    <section className="rounded-md border p-4 grid min-w-0 gap-2 [overflow-wrap:anywhere]">
      <h2 className="font-semibold">{t("agreements.acceptanceRecord")}</h2>
      <p>
        {t("agreements.signerName")}: {record.name}
      </p>
      <p>
        {t("agreements.recipient")}: {record.intendedRecipient ?? t("agreements.unspecified")}
      </p>
      <p>
        {t("agreements.acceptedAt")}: {record.at}
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
      <p className="text-xs font-mono break-all">
        {t("agreements.hash")}: {record.hash}
      </p>
      <p className="text-sm text-muted-foreground">{t("agreements.identityNotice")}</p>
    </section>
  )
}
