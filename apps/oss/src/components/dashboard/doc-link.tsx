import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"

import type { ActivityTarget } from "./activity-events"

type DocumentKind = "invoice" | "quote" | "creditNote" | "agreement"

/**
 * A link to one document by kind and id, so lists can point at invoices, quotes, credit notes and
 * agreements without each repeating the route and its params.
 */
export function DocLink({
  kind,
  id,
  className,
  "aria-label": ariaLabel,
  children,
}: {
  kind: DocumentKind
  id: string
  className?: string
  "aria-label"?: string
  children: ReactNode
}) {
  switch (kind) {
    case "invoice":
      return (
        <Link
          to="/invoices/$invoiceId"
          params={{ invoiceId: id }}
          search={{ emailWarning: undefined }}
          className={className}
          aria-label={ariaLabel}
        >
          {children}
        </Link>
      )
    case "quote":
      return (
        <Link to="/quotes/$quoteId" params={{ quoteId: id }} className={className} aria-label={ariaLabel}>
          {children}
        </Link>
      )
    case "creditNote":
      return (
        <Link
          to="/credit-notes/$creditNoteId"
          params={{ creditNoteId: id }}
          className={className}
          aria-label={ariaLabel}
        >
          {children}
        </Link>
      )
    case "agreement":
      return (
        <Link
          to="/agreements/$agreementId"
          params={{ agreementId: id }}
          className={className}
          aria-label={ariaLabel}
        >
          {children}
        </Link>
      )
  }
}

export function targetKind(target: ActivityTarget): { kind: DocumentKind; id: string } | null {
  return target.to === "none" ? null : { kind: target.to, id: target.id }
}
