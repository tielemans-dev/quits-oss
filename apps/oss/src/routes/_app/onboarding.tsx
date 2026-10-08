import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { OnboardingMissingField } from '@quits/contracts/onboarding'
import type { RuntimeCapabilities } from '@quits/contracts/runtime'
import { useEffect, useState } from 'react'
import { authClient, useSession } from '../../lib/auth-client'
import { switchActiveOrganization } from '../../lib/active-organization'
import { useRuntimeDistribution } from '../../lib/runtime-distribution'
import {
  getOrganizationAccessState,
  type OrganizationAccessState,
  type OrganizationSummary,
} from '../../lib/organization-access'
import { trpc } from '../../trpc/client'
import { Button } from '../../components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import { useI18n } from '../../lib/i18n/react'
import { countryOptionsIncluding, localeOptionsIncluding, TAX_REGIMES } from '../../lib/compliance/countries'
import { getOnboardingRules, type OnboardingInvoicingIdentity } from '../../lib/onboarding/rules'
import { AiAssistantPanel } from '../../components/onboarding/ai-assistant-panel'

export const Route = createFileRoute('/_app/onboarding')({
  component: OnboardingPage,
})

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
}

type CloudOnboardingMethod = 'manual' | 'ai'
type CloudTaxRegime = 'us_sales_tax' | 'eu_vat' | 'custom'
type AutoFillField = 'locale' | 'timezone' | 'defaultCurrency' | 'taxRegime' | 'pricesIncludeTax'

type CloudOnboardingValues = {
  companyName: string
  companyAddress: string
  companyEmail: string
  countryCode: string
  invoicingIdentity: OnboardingInvoicingIdentity
  locale: string
  timezone: string
  defaultCurrency: string
  taxRegime: CloudTaxRegime
  pricesIncludeTax: boolean
  primaryTaxId: string
  primaryTaxIdScheme: string
  invoicePrefix: string
  quotePrefix: string
}

const CURRENCIES = [
  { value: 'USD', label: 'USD' },
  { value: 'DKK', label: 'DKK' },
  { value: 'EUR', label: 'EUR' },
  { value: 'GBP', label: 'GBP' },
  { value: 'CAD', label: 'CAD' },
  { value: 'AUD', label: 'AUD' },
]

const DEFAULT_CLOUD_ONBOARDING_VALUES: CloudOnboardingValues = {
  companyName: '',
  companyAddress: '',
  companyEmail: '',
  countryCode: 'US',
  invoicingIdentity: 'registered_business',
  locale: 'en-US',
  timezone: 'UTC',
  defaultCurrency: 'USD',
  taxRegime: 'us_sales_tax',
  pricesIncludeTax: false,
  primaryTaxId: '',
  primaryTaxIdScheme: 'vat',
  invoicePrefix: 'INV',
  quotePrefix: 'QTE',
}

function parseCloudOnboardingValues(values?: Record<string, unknown> | null): CloudOnboardingValues {
  return {
    companyName: String(values?.companyName ?? ''),
    companyAddress: String(values?.companyAddress ?? ''),
    companyEmail: String(values?.companyEmail ?? ''),
    countryCode: String(values?.countryCode ?? 'US'),
    invoicingIdentity:
      values?.invoicingIdentity === 'individual' ? 'individual' : 'registered_business',
    locale: String(values?.locale ?? 'en-US'),
    timezone: String(values?.timezone ?? 'UTC'),
    defaultCurrency: String(values?.defaultCurrency ?? 'USD'),
    taxRegime: (values?.taxRegime as CloudTaxRegime) ?? 'us_sales_tax',
    pricesIncludeTax: Boolean(values?.pricesIncludeTax),
    primaryTaxId: String(values?.primaryTaxId ?? ''),
    primaryTaxIdScheme: String(values?.primaryTaxIdScheme ?? 'vat'),
    invoicePrefix: String(values?.invoicePrefix ?? 'INV'),
    quotePrefix: String(values?.quotePrefix ?? 'QTE'),
  }
}

function OnboardingPage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const { isCloud } = useRuntimeDistribution()
  const { data: session } = useSession()
  const hasActiveOrg = Boolean(session?.session.activeOrganizationId)

  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [statusLoading, setStatusLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [orgAccessState, setOrgAccessState] = useState<OrganizationAccessState>({
    kind: 'create',
  })
  const [orgAccessLoading, setOrgAccessLoading] = useState(false)
  const [method, setMethod] = useState<CloudOnboardingMethod>('manual')
  const [missingFields, setMissingFields] = useState<OnboardingMissingField[]>([])
  const [runtimeCapabilities, setRuntimeCapabilities] = useState<
    Pick<RuntimeCapabilities, 'onboardingAi'> | null
  >(null)
  const [values, setValues] = useState<CloudOnboardingValues>(
    DEFAULT_CLOUD_ONBOARDING_VALUES
  )
  const [manualOverrides, setManualOverrides] = useState<Record<AutoFillField, boolean>>({
    locale: false,
    timezone: false,
    defaultCurrency: false,
    taxRegime: false,
    pricesIncludeTax: false,
  })

  const onboardingRules = getOnboardingRules({
    countryCode: values.countryCode,
    invoicingIdentity: values.invoicingIdentity,
    taxRegime: values.taxRegime,
  })

  useEffect(() => {
    if (hasActiveOrg) {
      setOrgAccessLoading(false)
      return
    }

    let cancelled = false
    setOrgAccessLoading(true)

    async function loadOrganizations() {
      try {
        const result = await authClient.organization.list()
        if (cancelled) {
          return
        }

        const accessState = getOrganizationAccessState({
          organizations: (result.data ?? []) as OrganizationSummary[],
        })

        if (accessState.kind === 'auto-select') {
          // Loads a new page acting for the organization: onboarding continues there in cloud.
          const switched = await switchActiveOrganization(accessState.organizationId, {
            destination: isCloud ? '/onboarding' : '/',
            isCancelled: () => cancelled,
          })
          if (!switched?.error || cancelled) {
            return
          }
          setOrgAccessState({ kind: 'choose', organizations: (result.data ?? []) as OrganizationSummary[] })
          return
        }

        setOrgAccessState(accessState)
      } catch {
        if (!cancelled) {
          setOrgAccessState({ kind: 'create' })
        }
      } finally {
        if (!cancelled) {
          setOrgAccessLoading(false)
        }
      }
    }

    void loadOrganizations()

    return () => {
      cancelled = true
    }
  }, [hasActiveOrg, isCloud])

  useEffect(() => {
    if (!isCloud || !hasActiveOrg) {
      return
    }

    let cancelled = false
    setStatusLoading(true)

    trpc.onboarding.getStatus
      .query()
      .then((status) => {
        if (cancelled) {
          return
        }

        if (status.values) {
          setValues(parseCloudOnboardingValues(status.values))
          setManualOverrides({
            locale: false,
            timezone: false,
            defaultCurrency: false,
            taxRegime: false,
            pricesIncludeTax: false,
          })
          if (status.values.onboardingMethod === 'ai') {
            setMethod('ai')
          }
        }

        setMissingFields(
          Array.isArray(status.missing) ? (status.missing as OnboardingMissingField[]) : []
        )

        if (status.isComplete) {
          navigate({ to: '/' })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError('Unable to load onboarding status')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setStatusLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [hasActiveOrg, isCloud, navigate])

  useEffect(() => {
    if (!isCloud || !hasActiveOrg) {
      setRuntimeCapabilities(null)
      return
    }

    let cancelled = false

    trpc.runtime.capabilities
      .query()
      .then((capabilities) => {
        if (!cancelled) {
          setRuntimeCapabilities(
            capabilities as Pick<RuntimeCapabilities, 'onboardingAi'>
          )
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRuntimeCapabilities(null)
          setMethod('manual')
        }
      })

    return () => {
      cancelled = true
    }
  }, [hasActiveOrg, isCloud])

  useEffect(() => {
    if (!runtimeCapabilities?.onboardingAi.enabled && method === 'ai') {
      setMethod('manual')
    }
  }, [method, runtimeCapabilities])

  function handleNameChange(value: string) {
    setName(value)
    if (!slugTouched) {
      setSlug(slugify(value))
    }
  }

  function updateValue<Key extends keyof CloudOnboardingValues>(
    key: Key,
    value: CloudOnboardingValues[Key],
    options?: { markManual?: boolean }
  ) {
    setValues((current) => ({
      ...current,
      [key]: value,
    }))

    const shouldTrackManual =
      options?.markManual !== false &&
      (key === 'locale' ||
        key === 'timezone' ||
        key === 'defaultCurrency' ||
        key === 'taxRegime' ||
        key === 'pricesIncludeTax')

    if (shouldTrackManual) {
      setManualOverrides((current) => ({
        ...current,
        [key]: true,
      }))
    }
  }

  function applySuggestedDefaults(
    countryCode: string,
    invoicingIdentity: OnboardingInvoicingIdentity
  ) {
    const defaults = getOnboardingRules({
      countryCode,
      invoicingIdentity,
    }).defaults

    setValues((current) => ({
      ...current,
      countryCode,
      invoicingIdentity,
      locale: manualOverrides.locale ? current.locale : defaults.locale,
      timezone: manualOverrides.timezone ? current.timezone : defaults.timezone,
      defaultCurrency: manualOverrides.defaultCurrency
        ? current.defaultCurrency
        : defaults.defaultCurrency,
      taxRegime: manualOverrides.taxRegime ? current.taxRegime : defaults.taxRegime,
      pricesIncludeTax: manualOverrides.pricesIncludeTax
        ? current.pricesIncludeTax
        : defaults.pricesIncludeTax,
    }))
  }

  async function handleCreateOrganization(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)

    const result = await authClient.organization.create(
      { name, slug },
      {
        onError: (ctx) => {
          setError(ctx.error.message ?? t('auth.onboarding.error'))
        },
      }
    )

    if (!result.data) {
      setSubmitting(false)
      return
    }

    // Loads a new page acting for the new organization.
    const switched = await switchActiveOrganization(result.data.id)
    if (switched?.error) {
      setError(switched.error.message ?? t('auth.onboarding.error'))
      setSubmitting(false)
    }
  }

  async function handleSelectOrganization(organizationId: string) {
    setError(null)
    setSubmitting(true)

    try {
      // Loads a new page acting for the selected organization.
      const switched = await switchActiveOrganization(organizationId)
      if (switched?.error) {
        setError(switched.error.message ?? t('auth.onboarding.error'))
        setSubmitting(false)
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t('auth.onboarding.error')
      setError(message)
      setSubmitting(false)
    }
  }

  async function handleCompleteCloudOnboarding(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)

    try {
      const draft = await trpc.onboarding.saveDraft.mutate({
        companyName: values.companyName,
        companyAddress: values.companyAddress,
        companyEmail: values.companyEmail,
        countryCode: values.countryCode,
        invoicingIdentity: values.invoicingIdentity,
        locale: values.locale,
        timezone: values.timezone,
        defaultCurrency: values.defaultCurrency,
        taxRegime: values.taxRegime,
        pricesIncludeTax: values.pricesIncludeTax,
        primaryTaxId: values.primaryTaxId.trim() || null,
        primaryTaxIdScheme: values.primaryTaxIdScheme,
        invoicePrefix: values.invoicePrefix,
        quotePrefix: values.quotePrefix,
      })

      setMissingFields(Array.isArray(draft.missing) ? draft.missing : [])

      await trpc.onboarding.completeManual.mutate({ method })
      navigate({ to: '/' })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Unable to complete onboarding'
      setError(message)
      setSubmitting(false)
    }
  }

  if (!hasActiveOrg) {
    if (orgAccessLoading) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-background px-4">
          <Card className="w-full max-w-sm">
            <CardHeader>
              <CardTitle className="text-2xl">{t('auth.onboarding.select.title')}</CardTitle>
              <CardDescription>
                {t('auth.onboarding.select.loading')}
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      )
    }

    if (orgAccessState.kind === 'choose') {
      return (
        <div className="flex min-h-screen items-center justify-center bg-background px-4">
          <Card className="w-full max-w-sm">
            <CardHeader>
              <CardTitle className="text-2xl">{t('auth.onboarding.select.title')}</CardTitle>
              <CardDescription>
                {t('auth.onboarding.select.description')}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
              {orgAccessState.organizations.map((organization) => (
                <Button
                  key={organization.id}
                  type="button"
                  variant="outline"
                  className="w-full justify-start"
                  disabled={submitting}
                  onClick={() => void handleSelectOrganization(organization.id)}
                >
                  {organization.name}
                </Button>
              ))}
            </CardContent>
            <CardFooter>
              <Button
                type="button"
                className="w-full"
                disabled={submitting}
                onClick={() => setOrgAccessState({ kind: 'create' })}
              >
                {t('auth.onboarding.submit')}
              </Button>
            </CardFooter>
          </Card>
        </div>
      )
    }

    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="text-2xl">{t('auth.onboarding.title')}</CardTitle>
            <CardDescription>
              {t('auth.onboarding.description')}
            </CardDescription>
          </CardHeader>
          <form onSubmit={handleCreateOrganization}>
            <CardContent className="flex flex-col gap-4">
              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
              <div className="flex flex-col gap-2">
                <Label htmlFor="org-name">{t('auth.onboarding.orgName')}</Label>
                <Input
                  id="org-name"
                  type="text"
                  placeholder={t('auth.onboarding.placeholder.orgName')}
                  value={name}
                  onChange={(e) => handleNameChange(e.target.value)}
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="org-slug">{t('auth.onboarding.slug')}</Label>
                <Input
                  id="org-slug"
                  type="text"
                  placeholder={t('auth.onboarding.placeholder.slug')}
                  value={slug}
                  onChange={(e) => {
                    setSlug(e.target.value)
                    setSlugTouched(true)
                  }}
                  required
                />
                <p className="text-xs text-muted-foreground">
                  {t('auth.onboarding.slugHelp')}
                </p>
              </div>
            </CardContent>
            <CardFooter>
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? t('auth.onboarding.submitting') : t('auth.onboarding.submit')}
              </Button>
            </CardFooter>
          </form>
        </Card>
      </div>
    )
  }

  if (!isCloud) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="text-2xl">{t('auth.onboarding.configured.title')}</CardTitle>
            <CardDescription>
              {t('auth.onboarding.configured.description')}
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button type="button" className="w-full" onClick={() => navigate({ to: '/' })}>
              {t('auth.onboarding.configured.continue')}
            </Button>
          </CardFooter>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
      <Card className="w-full max-w-4xl">
        <CardHeader>
          <CardTitle className="text-2xl">Finish organization setup</CardTitle>
          <CardDescription>
            Complete these defaults once so you can immediately create invoices and quotes.
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleCompleteCloudOnboarding}>
          <CardContent className="space-y-6">
            {error && (
              <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
                {error}
              </p>
            )}

            {statusLoading && (
              <p className="text-sm text-muted-foreground">Loading onboarding state…</p>
            )}

            <div className={`grid gap-3 ${runtimeCapabilities?.onboardingAi.enabled ? 'md:grid-cols-2' : ''}`}>
              <button
                type="button"
                onClick={() => setMethod('manual')}
                className={`rounded-lg border p-4 text-left ${method === 'manual' ? 'border-primary bg-primary/5' : 'border-border'}`}
              >
                <p className="text-sm font-semibold">Manual setup</p>
                <p className="mt-1 text-xs text-muted-foreground">Fill all required fields directly.</p>
              </button>
              {runtimeCapabilities?.onboardingAi.enabled ? (
                <button
                  type="button"
                  onClick={() => setMethod('ai')}
                  className={`rounded-lg border p-4 text-left ${method === 'ai' ? 'border-primary bg-primary/5' : 'border-border'}`}
                >
                  <p className="text-sm font-semibold">AI setup assistant (cloud only)</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    AI mode uses managed cloud credits. You can switch to manual at any time.
                  </p>
                </button>
              ) : null}
            </div>

            {runtimeCapabilities?.onboardingAi.enabled && method === 'ai' ? (
              <AiAssistantPanel
                values={values}
                missing={missingFields}
                disabled={submitting || statusLoading}
                onApplied={(result) => {
                  setValues(parseCloudOnboardingValues(result.values))
                  setManualOverrides({
                    locale: false,
                    timezone: false,
                    defaultCurrency: false,
                    taxRegime: false,
                    pricesIncludeTax: false,
                  })
                  setMissingFields(Array.isArray(result.missing) ? result.missing : [])
                }}
              />
            ) : null}

            {missingFields.length > 0 ? (
              <div className="rounded-md border border-border p-3 text-sm text-muted-foreground">
                Missing required fields: {missingFields.join(', ')}
              </div>
            ) : null}

            <section className="space-y-4 rounded-lg border border-border p-4">
              <div className="space-y-1">
                <h2 className="text-lg font-semibold">Business basics</h2>
                <p className="text-sm text-muted-foreground">
                  Start with the minimum details that determine which defaults and tax
                  requirements apply.
                </p>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="companyName">Company name</Label>
                  <Input
                    id="companyName"
                    value={values.companyName}
                    onChange={(e) => updateValue('companyName', e.target.value)}
                    required
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="companyEmail">Billing email</Label>
                  <Input
                    id="companyEmail"
                    type="email"
                    value={values.companyEmail}
                    onChange={(e) => updateValue('companyEmail', e.target.value)}
                    required
                  />
                </div>
                <div className="flex flex-col gap-2 md:col-span-2">
                  <Label htmlFor="companyAddress">Company address</Label>
                  <Input
                    id="companyAddress"
                    value={values.companyAddress}
                    onChange={(e) => updateValue('companyAddress', e.target.value)}
                    required
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="countryCode">Country</Label>
                  <select
                    id="countryCode"
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    value={values.countryCode}
                    onChange={(e) =>
                      applySuggestedDefaults(e.target.value, values.invoicingIdentity)
                    }
                  >
                    {countryOptionsIncluding(values.countryCode).map((country) => (
                      <option key={country.code} value={country.code}>
                        {country.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-2">
                <Label>How do you invoice?</Label>
                <div className="grid gap-3 md:grid-cols-2">
                  <button
                    type="button"
                    aria-pressed={values.invoicingIdentity === 'individual'}
                    className={`rounded-lg border p-4 text-left ${
                      values.invoicingIdentity === 'individual'
                        ? 'border-primary bg-primary/5'
                        : 'border-border'
                    }`}
                    onClick={() => applySuggestedDefaults(values.countryCode, 'individual')}
                  >
                    <p className="text-sm font-semibold">I invoice as an individual</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Use this when you do not invoice through a registered company.
                    </p>
                  </button>
                  <button
                    type="button"
                    aria-pressed={values.invoicingIdentity === 'registered_business'}
                    className={`rounded-lg border p-4 text-left ${
                      values.invoicingIdentity === 'registered_business'
                        ? 'border-primary bg-primary/5'
                        : 'border-border'
                    }`}
                    onClick={() =>
                      applySuggestedDefaults(values.countryCode, 'registered_business')
                    }
                  >
                    <p className="text-sm font-semibold">
                      I invoice through a registered business
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Use your company defaults and any tax identity the selected setup
                      requires.
                    </p>
                  </button>
                </div>
              </div>
            </section>

            <section className="space-y-4 rounded-lg border border-border p-4">
              <div className="space-y-1">
                <h2 className="text-lg font-semibold">Confirm defaults</h2>
                <p className="text-sm text-muted-foreground">
                  We suggested these defaults from your country and business type. Review
                  them now and adjust anything that should work differently for your
                  invoices.
                </p>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="locale">Locale</Label>
                  <select
                    id="locale"
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    value={values.locale}
                    onChange={(e) => updateValue('locale', e.target.value)}
                  >
                    {localeOptionsIncluding(values.locale).map((locale) => (
                      <option key={locale} value={locale}>
                        {locale}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="timezone">Timezone</Label>
                  <Input
                    id="timezone"
                    value={values.timezone}
                    onChange={(e) => updateValue('timezone', e.target.value)}
                    required
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="defaultCurrency">Default currency</Label>
                  <select
                    id="defaultCurrency"
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    value={values.defaultCurrency}
                    onChange={(e) => updateValue('defaultCurrency', e.target.value)}
                  >
                    {CURRENCIES.map((currency) => (
                      <option key={currency.value} value={currency.value}>
                        {currency.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="taxRegime">Tax setup</Label>
                  <select
                    id="taxRegime"
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    value={values.taxRegime}
                    onChange={(e) => updateValue('taxRegime', e.target.value as CloudTaxRegime)}
                  >
                    {TAX_REGIMES.map((regime) => (
                      <option key={regime.value} value={regime.value}>
                        {regime.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </section>

            <section className="space-y-4 rounded-lg border border-border p-4">
              <div className="space-y-1">
                <h2 className="text-lg font-semibold">Relevant compliance details</h2>
                <p className="text-sm text-muted-foreground">
                  We only ask for extra tax identifiers when the selected setup needs
                  them.
                </p>
              </div>

              {onboardingRules.showPrimaryTaxId ? (
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="primaryTaxId">
                      {onboardingRules.primaryTaxIdCopy.label}
                    </Label>
                    <Input
                      id="primaryTaxId"
                      value={values.primaryTaxId}
                      onChange={(e) => updateValue('primaryTaxId', e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      {onboardingRules.primaryTaxIdCopy.help}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No additional tax ID is needed for this setup right now.
                </p>
              )}
            </section>

            <details className="rounded-lg border border-border p-4">
              <summary className="cursor-pointer list-none text-lg font-semibold">
                Advanced defaults
              </summary>
              <p className="mt-2 text-sm text-muted-foreground">
                These values are prefilled so you can start immediately, but you can
                still change them before you finish onboarding.
              </p>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="invoicePrefix">Invoice prefix</Label>
                  <Input
                    id="invoicePrefix"
                    value={values.invoicePrefix}
                    onChange={(e) => updateValue('invoicePrefix', e.target.value.toUpperCase())}
                    required
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="quotePrefix">Quote prefix</Label>
                  <Input
                    id="quotePrefix"
                    value={values.quotePrefix}
                    onChange={(e) => updateValue('quotePrefix', e.target.value.toUpperCase())}
                    required
                  />
                </div>
                <label className="flex items-center gap-2 text-sm md:col-span-2">
                  <input
                    type="checkbox"
                    checked={values.pricesIncludeTax}
                    onChange={(e) => updateValue('pricesIncludeTax', e.target.checked)}
                  />
                  Prices include tax
                </label>
              </div>
            </details>
          </CardContent>
          <CardFooter className="pt-3">
            <Button type="submit" className="w-full" disabled={submitting || statusLoading}>
              {submitting ? 'Finishing onboarding…' : 'Finish onboarding'}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  )
}
