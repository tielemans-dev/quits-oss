import { normalizeLocale } from "../../lib/i18n/locale"

export function formatDateTime(value: Date | string, locale: string) {
  return new Intl.DateTimeFormat(normalizeLocale(locale), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

/** The MCP endpoint for this installation, as agents should call it. */
export function mcpEndpointUrl() {
  const origin = typeof window === "undefined" ? "" : window.location.origin
  return `${origin}/api/mcp`
}
