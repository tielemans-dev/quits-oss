import { createFileRoute } from '@tanstack/react-router'
import { TRPCClientError } from '@trpc/client'
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { AgentModeBadge } from '../components/agents/agent-mode-badge'
import { Button } from '../components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../components/ui/card'
import { useI18n } from '../lib/i18n/react'
import { loadPage } from '../lib/page-navigation'
import { trpc } from '../trpc/client'

const consentSearchSchema = z.object({ request: z.string().optional() })

export const Route = createFileRoute('/oauth/consent')({
  validateSearch: consentSearchSchema,
  component: ConsentPage,
})

type ConsentRequest = Awaited<ReturnType<typeof trpc.connectors.consentRequest.query>>
type PresetId = ConsentRequest['presets'][number]['id']

function isUnauthorized(error: unknown) {
  return error instanceof TRPCClientError && error.data?.code === 'UNAUTHORIZED'
}

/** Where a person decides whether an MCP client may act for them (sign-in prototype, issue #31). */
function ConsentPage() {
  const { t } = useI18n()
  const { request: requestId } = Route.useSearch()
  const [consent, setConsent] = useState<ConsentRequest | null>(null)
  const [presetId, setPresetId] = useState<PresetId>('read_only')
  const [confirmFullAccess, setConfirmFullAccess] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    setConsent(null)
    setConfirmFullAccess(false)
    if (!requestId) {
      setError(t('connectors.consent.error.load'))
      return
    }
    let cancelled = false
    trpc.connectors.consentRequest
      .query({ requestId })
      .then((result) => {
        if (cancelled) return
        setConsent(result)
        setPresetId(result.suggestedPreset)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        if (isUnauthorized(cause)) {
          const here = `/oauth/consent?request=${encodeURIComponent(requestId)}`
          loadPage(`/login?redirect=${encodeURIComponent(here)}`)
          return
        }
        setError(t('connectors.consent.error.load'))
      })
    return () => {
      cancelled = true
    }
  }, [requestId, t])

  async function decide(decision: 'approve' | 'deny') {
    if (!requestId || !consent) return
    setSubmitting(true)
    setError(null)
    try {
      const { redirectTo } = await trpc.connectors.decide.mutate(
        decision === 'deny'
          ? { requestId, reviewId: consent.reviewId, decision }
          : { requestId, reviewId: consent.reviewId, decision, presetId, confirmFullAccess },
      )
      window.location.assign(redirectTo)
    } catch {
      setConsent(null)
      setError(t('connectors.consent.error.decide'))
      setSubmitting(false)
    }
  }

  const client = consent?.client.name ?? ''
  const selected = consent?.presets.find((preset) => preset.id === presetId)
  const needsConfirmation = selected?.mode === 'full_access' && !confirmFullAccess

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle className="text-2xl">
            {consent ? t('connectors.consent.title', { client }) : t('connectors.consent.loading')}
          </CardTitle>
          {consent ? (
            <CardDescription>
              {t('connectors.consent.description', { client, organization: consent.organizationName })}
            </CardDescription>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          {consent ? (
            <>
              <div className="grid gap-1 text-sm text-muted-foreground">
                <p>{t('connectors.consent.returnTo', { host: consent.redirectHost })}</p>
                <p>{t(`connectors.consent.registration.${consent.client.registration}`)}</p>
                <p className="break-all font-mono text-xs">
                  {t('connectors.consent.clientId', { id: consent.client.id })}
                </p>
              </div>
              {consent.loopbackRedirect ? (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm" role="note">
                  {t('connectors.consent.loopbackWarning', { host: consent.redirectHost })}
                </p>
              ) : null}
              {!consent.canConnect ? (
                <p className="text-sm text-destructive" role="alert">
                  {t('connectors.consent.cannotConnect')}
                </p>
              ) : (
                <fieldset className="grid gap-2">
                  <legend className="mb-1 text-sm font-medium">{t('connectors.consent.access')}</legend>
                  {consent.requestedScopes.length > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {t('connectors.consent.requested', { scopes: consent.requestedScopes.join(', ') })}
                    </p>
                  ) : null}
                  {consent.presets.map((preset) => (
                    <label
                      key={preset.id}
                      className="flex cursor-pointer gap-3 rounded-md border p-3 has-[:checked]:border-primary"
                    >
                      <input
                        type="radio"
                        name="preset"
                        value={preset.id}
                        checked={presetId === preset.id}
                        disabled={preset.scopes.length === 0}
                        onChange={() => {
                          setPresetId(preset.id)
                          setConfirmFullAccess(false)
                        }}
                        className="mt-1"
                      />
                      <span className="grid gap-1">
                        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          {t(`connectors.consent.preset.${preset.id}`)}
                          <AgentModeBadge mode={preset.mode} />
                        </span>
                        <span className="text-sm text-muted-foreground">
                          {t(`connectors.consent.preset.${preset.id}.help`)}
                        </span>
                        <span className="text-xs text-muted-foreground" title={preset.scopes.join(', ')}>
                          {t('connectors.consent.scopeCount', { count: preset.scopes.length })}
                        </span>
                      </span>
                    </label>
                  ))}
                  {selected?.mode === 'full_access' ? (
                    <label className="flex gap-3 text-sm">
                      <input
                        type="checkbox"
                        checked={confirmFullAccess}
                        onChange={(event) => setConfirmFullAccess(event.target.checked)}
                        className="mt-1"
                      />
                      <span>{t('connectors.consent.fullAccessConfirm', { client })}</span>
                    </label>
                  ) : null}
                  <p className="text-xs text-muted-foreground">{t('connectors.consent.limits')}</p>
                </fieldset>
              )}
            </>
          ) : null}
        </CardContent>
        {consent ? (
          <CardFooter className="flex justify-end gap-2">
            <Button variant="outline" disabled={submitting} onClick={() => void decide('deny')}>
              {t('connectors.consent.deny')}
            </Button>
            <Button
              disabled={submitting || !consent.canConnect || needsConfirmation}
              onClick={() => void decide('approve')}
            >
              {t('connectors.consent.approve')}
            </Button>
          </CardFooter>
        ) : null}
      </Card>
    </div>
  )
}
