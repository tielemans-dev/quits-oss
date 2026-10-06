import { useI18n } from "../../lib/i18n/react"
import { Label } from "../ui/label"
import { CopyButton } from "./copy-button"
import { mcpEndpointUrl } from "./format"

function CopyableBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <Label>{label}</Label>
        <CopyButton value={value} />
      </div>
      <pre className="overflow-x-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs whitespace-pre">
        {value}
      </pre>
    </div>
  )
}

/** Shows a freshly created secret once, with ready-to-paste client configuration. */
export function AgentKeySecret({ secret }: { secret: string }) {
  const { t } = useI18n()
  const endpoint = mcpEndpointUrl()
  const claudeCode = `claude mcp add --transport http yaip ${endpoint} --header "Authorization: Bearer ${secret}"`
  const config = JSON.stringify(
    {
      mcpServers: {
        yaip: { type: "http", url: endpoint, headers: { Authorization: `Bearer ${secret}` } },
      },
    },
    null,
    2
  )

  return (
    <div className="grid gap-4">
      <CopyableBlock label={t("agents.secret.key")} value={secret} />
      <CopyableBlock label={t("agents.secret.endpoint")} value={endpoint} />
      <CopyableBlock label={t("agents.secret.claudeCode")} value={claudeCode} />
      <CopyableBlock label={t("agents.secret.config")} value={config} />
    </div>
  )
}
