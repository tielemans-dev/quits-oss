import { useState } from "react"
import {
  agentScopePresets,
  type AgentMode,
  type AgentScopePresetId,
} from "@quits/contracts/agent"
import { useI18n } from "../../lib/i18n/react"
import { trpc } from "../../trpc/client"
import { Button } from "../ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog"
import { Input } from "../ui/input"
import { Label } from "../ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select"
import { AgentKeySecret } from "./agent-key-secret"
import { ScopePicker } from "./scope-picker"
import type { CreatedAgentKey } from "./types"

const PRESET_IDS: AgentScopePresetId[] = ["read_only_bookkeeper", "drafting_assistant", "full_access"]
const MODES: AgentMode[] = ["read_only", "approval_required", "full_access"]
const EXPIRY_OPTIONS = ["never", "30", "90", "365"] as const

function presetScopes(preset: AgentScopePresetId, grantable: readonly string[]) {
  const scopes = agentScopePresets[preset].scopes
  return new Set(scopes === "all" ? grantable : scopes.filter((scope) => grantable.includes(scope)))
}

export function CreateAgentKeyDialog({
  open,
  onOpenChange,
  grantableScopes,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  grantableScopes: readonly string[]
  onCreated: () => void
}) {
  const { t } = useI18n()
  const [name, setName] = useState("")
  const [preset, setPreset] = useState<AgentScopePresetId>("drafting_assistant")
  const [mode, setMode] = useState<AgentMode>(agentScopePresets.drafting_assistant.mode)
  const [scopes, setScopes] = useState(() => presetScopes("drafting_assistant", grantableScopes))
  const [showScopes, setShowScopes] = useState(false)
  const [expiry, setExpiry] = useState<(typeof EXPIRY_OPTIONS)[number]>("never")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedAgentKey | null>(null)

  function reset() {
    setName("")
    choosePreset("drafting_assistant")
    setShowScopes(false)
    setExpiry("never")
    setError(null)
    setCreated(null)
  }

  function choosePreset(next: AgentScopePresetId) {
    setPreset(next)
    setMode(agentScopePresets[next].mode)
    setScopes(presetScopes(next, grantableScopes))
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset()
    onOpenChange(next)
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!name.trim()) return setError(t("agents.create.error.name"))
    if (scopes.size === 0) return setError(t("agents.create.error.scopes"))

    setSubmitting(true)
    setError(null)
    try {
      const result = await trpc.agents.createKey.mutate({
        name: name.trim(),
        mode,
        scopes: [...scopes],
        expiresInDays: expiry === "never" ? null : Number(expiry),
      })
      setCreated(result)
      onCreated()
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : t("agents.create.error.generic"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("agents.secret.title")}</DialogTitle>
              <DialogDescription>{t("agents.secret.description")}</DialogDescription>
            </DialogHeader>
            <AgentKeySecret secret={created.secret} />
            <DialogFooter>
              <Button type="button" onClick={() => handleOpenChange(false)}>
                {t("agents.secret.done")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form onSubmit={submit} className="grid gap-5">
            <DialogHeader>
              <DialogTitle>{t("agents.create.title")}</DialogTitle>
              <DialogDescription>{t("agents.create.description")}</DialogDescription>
            </DialogHeader>

            <div className="grid gap-2">
              <Label htmlFor="agent-key-name">{t("agents.create.name")}</Label>
              <Input
                id="agent-key-name"
                value={name}
                maxLength={80}
                placeholder={t("agents.create.namePlaceholder")}
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            <div className="grid gap-2">
              <Label>{t("agents.create.preset")}</Label>
              <div className="grid gap-2 sm:grid-cols-3">
                {PRESET_IDS.map((id) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={preset === id}
                    onClick={() => choosePreset(id)}
                    className={`rounded-md border p-3 text-left text-sm transition-colors hover:bg-accent ${
                      preset === id ? "border-primary ring-1 ring-primary" : ""
                    }`}
                  >
                    <div className="font-medium">{t(`agents.create.preset.${id}`)}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {t(`agents.create.preset.${id}.help`)}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="agent-key-mode">{t("agents.create.mode")}</Label>
                <Select value={mode} onValueChange={(value) => setMode(value as AgentMode)}>
                  <SelectTrigger id="agent-key-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MODES.map((option) => (
                      <SelectItem key={option} value={option}>
                        {t(`agents.mode.${option}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t(`agents.mode.${mode}.help`)}</p>
              </div>
              <div className="grid gap-2 content-start">
                <Label htmlFor="agent-key-expiry">{t("agents.create.expiry")}</Label>
                <Select
                  value={expiry}
                  onValueChange={(value) => setExpiry(value as (typeof EXPIRY_OPTIONS)[number])}
                >
                  <SelectTrigger id="agent-key-expiry">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRY_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option === "never"
                          ? t("agents.create.expiry.never")
                          : t("agents.create.expiry.days", { days: option })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-2">
              <button
                type="button"
                className="justify-self-start text-sm font-medium underline-offset-4 hover:underline"
                aria-expanded={showScopes}
                onClick={() => setShowScopes((value) => !value)}
              >
                {t("agents.create.advanced")}
              </button>
              <p className="text-xs text-muted-foreground">
                {t("agents.create.scopesHint", { count: scopes.size })}
              </p>
              {showScopes ? (
                <ScopePicker available={grantableScopes} selected={scopes} onChange={setScopes} />
              ) : null}
            </div>

            {error ? <p className="text-sm text-destructive">{error}</p> : null}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                {t("agents.create.cancel")}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? t("agents.create.creating") : t("agents.create.submit")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
