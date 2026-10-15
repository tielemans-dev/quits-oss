import type {
  OnboardingAiSuggestion,
  OnboardingMissingField,
  OnboardingValues,
} from "@quits/contracts/onboarding"
import { onboardingValuesSchema } from "@quits/contracts/onboarding"
import { useMemo, useState } from "react"
import { Button } from "../ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card"
import { Textarea } from "../ui/textarea"
import type { TranslationKey } from "../../lib/i18n/messages"
import { useI18n } from "../../lib/i18n/react"
import { trpc } from "../../trpc/client"

type AiAssistantPanelProps = {
  values: OnboardingValues
  missing: OnboardingMissingField[]
  disabled?: boolean
  onApplied: (result: {
    values: OnboardingValues
    missing: OnboardingMissingField[]
    isComplete: boolean
  }) => void
}

export function AiAssistantPanel({
  values,
  missing,
  disabled = false,
  onApplied,
}: AiAssistantPanelProps) {
  const { t } = useI18n()
  const [prompt, setPrompt] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [suggestion, setSuggestion] = useState<OnboardingAiSuggestion | null>(null)

  const patchEntries = useMemo(
    () => Object.entries(suggestion?.patch ?? {}),
    [suggestion]
  )

  async function handleSuggest() {
    setError(null)
    setBusy(true)

    try {
      const nextSuggestion = await trpc.onboardingAi.suggestOnboardingPatch.mutate({
        userMessage: prompt,
        currentValues: values,
        missing,
      })
      setSuggestion(nextSuggestion)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("auth.onboarding.ai.suggestError"))
    } finally {
      setBusy(false)
    }
  }

  async function handleApply() {
    if (!suggestion) return
    setError(null)
    setBusy(true)

    try {
      const applied = await trpc.onboardingAi.applyOnboardingPatch.mutate({
        source: "ai",
        patch: suggestion.patch,
      })
      onApplied({
        ...applied,
        values: onboardingValuesSchema.parse(applied.values),
      })
      setSuggestion(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("auth.onboarding.ai.applyError"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardHeader>
        <CardTitle className="text-base">{t("auth.onboarding.ai.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="space-y-2">
          <label htmlFor="onboarding-ai-prompt" className="text-sm font-medium">
            {t("auth.onboarding.ai.prompt")}
          </label>
          <Textarea
            id="onboarding-ai-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={t("auth.onboarding.ai.placeholder")}
            rows={4}
            disabled={disabled || busy}
          />
        </div>

        <div className="flex justify-end">
          <Button
            type="button"
            onClick={handleSuggest}
            disabled={disabled || busy || prompt.trim().length < 4}
          >
            {busy ? t("auth.onboarding.ai.thinking") : t("auth.onboarding.ai.suggest")}
          </Button>
        </div>

        {suggestion ? (
          <div className="space-y-3 rounded-md border border-border bg-background p-3">
            <p className="text-sm font-medium">{t("auth.onboarding.ai.proposed")}</p>
            {patchEntries.length > 0 ? (
              <ul className="space-y-1 text-sm text-muted-foreground">
                {patchEntries.map(([key, value]) => (
                  <li key={key}>
                    <span className="font-medium text-foreground">{t(`auth.onboarding.field.${key}` as TranslationKey)}:</span>{" "}
                    {String(value)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("auth.onboarding.ai.none")}
              </p>
            )}

            <p className="text-xs text-muted-foreground">
              {t("auth.onboarding.ai.confidence", { percent: (suggestion.confidence * 100).toFixed(0) })}
            </p>
            <p className="text-xs text-muted-foreground">{suggestion.rationale}</p>

            {suggestion.followupQuestions.length > 0 ? (
              <ul className="space-y-1 text-xs text-muted-foreground">
                {suggestion.followupQuestions.map((question) => (
                  <li key={question}>- {question}</li>
                ))}
              </ul>
            ) : null}

            <div className="flex justify-end">
              <Button
                type="button"
                onClick={handleApply}
                disabled={disabled || busy || patchEntries.length === 0}
              >
                {t("auth.onboarding.ai.apply")}
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
