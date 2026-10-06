import type { AgentMode } from "@yaip/contracts/agent"
import { useI18n } from "../../lib/i18n/react"
import { Badge } from "../ui/badge"

const variantByMode = {
  read_only: "secondary",
  approval_required: "outline",
  full_access: "default",
} as const

export function AgentModeBadge({ mode }: { mode: AgentMode }) {
  const { t } = useI18n()
  return <Badge variant={variantByMode[mode]}>{t(`agents.mode.${mode}`)}</Badge>
}
