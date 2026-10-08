import { useI18n } from "../lib/i18n/react"
import { StatusPill } from "./kvit/status-pill"
import { getStatusLabel, getStatusTone, type StatusDomain } from "../lib/status-tones"

/** A badge for a tone with a label the caller has already translated. */
export const ToneBadge = StatusPill

/**
 * The badge for a status of a domain (see `statusTones`): its tone, and its label in the current
 * language. A status this client does not know shows as it is, in the neutral tone.
 */
export function StatusBadge({
  domain,
  status,
  className,
}: {
  domain: StatusDomain
  status: string
  className?: string
}) {
  const { t } = useI18n()
  return (
    <ToneBadge tone={getStatusTone(domain, status)} className={className}>
      {getStatusLabel(t, domain, status)}
    </ToneBadge>
  )
}
