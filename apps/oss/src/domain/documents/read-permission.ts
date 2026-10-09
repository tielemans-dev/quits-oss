import type { Permission } from "../permissions"

/** Shared by document timelines and dashboard event projections. */
export const DOCUMENT_READ_PERMISSION = {
  agreement: "agreement:read",
  invoice: "invoice:read",
  quote: "quote:read",
  creditNote: "creditNote:read",
} as const satisfies Record<string, Permission>
