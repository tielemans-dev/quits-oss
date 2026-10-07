import { Check, Copy } from "lucide-react"
import { useState } from "react"
import { useI18n } from "../../lib/i18n/react"
import { Button } from "../ui/button"

export function CopyButton({ value }: { value: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access can be denied; the value stays selectable.
    }
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={copy}>
      {copied ? <Check /> : <Copy />}
      {copied ? t("agents.secret.copied") : t("agents.secret.copy")}
    </Button>
  )
}
