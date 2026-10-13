import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { DANISH_ONBOARDING_V2_DEFAULTS } from '@quits/contracts/onboarding'
import type { OnboardingMissingField } from '@quits/contracts/onboarding'
import type { RuntimeCapabilities } from '@quits/contracts/runtime'
import { useEffect, useMemo, useRef, useState } from 'react'
import { authClient, useSession } from '../../lib/auth-client'
import { switchActiveOrganization } from '../../lib/active-organization'
import { invalidateAppLayoutSession } from '../../lib/app-layout-session'
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
import { I18nProvider, useI18n } from '../../lib/i18n/react'
import { canonicalLocale, countryOptionsIncluding, LOCALE_OPTIONS, localeOptionsIncluding, TAX_REGIMES } from '../../lib/compliance/countries'
import { getOnboardingRules, type OnboardingInvoicingIdentity } from '../../lib/onboarding/rules'
import { loadPage } from '../../lib/page-navigation'
import { loginReturnSearchSchema, loginReturnTarget, loginReturnDestination, loginReturnOnboarding } from '../../lib/login-return'
import { AiAssistantPanel } from '../../components/onboarding/ai-assistant-panel'
import { createNamedOrganization } from '../../lib/organization-slug'
import type { CvrLookupCompany } from '../../lib/onboarding/search-cvr'
import { stageSelectedCompany, readSelectedCompany, clearSelectedCompany } from '../../lib/onboarding/selected-company'

export const Route = createFileRoute('/_app/onboarding')({
  validateSearch: loginReturnSearchSchema,
  component: OnboardingPage,
})

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
] as const

const DEFAULT_CLOUD_ONBOARDING_VALUES: CloudOnboardingValues = {
  companyName: '',
  companyAddress: '',
  companyEmail: '',
  countryCode: DANISH_ONBOARDING_V2_DEFAULTS.countryCode,
  invoicingIdentity: 'registered_business',
  locale: DANISH_ONBOARDING_V2_DEFAULTS.locale,
  timezone: DANISH_ONBOARDING_V2_DEFAULTS.timezone,
  defaultCurrency: DANISH_ONBOARDING_V2_DEFAULTS.defaultCurrency,
  taxRegime: DANISH_ONBOARDING_V2_DEFAULTS.taxRegime,
  pricesIncludeTax: DANISH_ONBOARDING_V2_DEFAULTS.pricesIncludeTax,
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
    countryCode: String(values?.countryCode ?? DANISH_ONBOARDING_V2_DEFAULTS.countryCode),
    invoicingIdentity:
      values?.invoicingIdentity === 'individual' ? 'individual' : 'registered_business',
    locale: String(values?.locale ?? DANISH_ONBOARDING_V2_DEFAULTS.locale),
    timezone: String(values?.timezone ?? DANISH_ONBOARDING_V2_DEFAULTS.timezone),
    defaultCurrency: String(values?.defaultCurrency ?? DANISH_ONBOARDING_V2_DEFAULTS.defaultCurrency),
    taxRegime: (values?.taxRegime as CloudTaxRegime) ?? DANISH_ONBOARDING_V2_DEFAULTS.taxRegime,
    pricesIncludeTax: Boolean(values?.pricesIncludeTax ?? DANISH_ONBOARDING_V2_DEFAULTS.pricesIncludeTax),
    primaryTaxId: String(values?.primaryTaxId ?? ''),
    primaryTaxIdScheme: String(values?.primaryTaxIdScheme ?? 'vat'),
    invoicePrefix: String(values?.invoicePrefix ?? 'INV'),
    quotePrefix: String(values?.quotePrefix ?? 'QTE'),
  }
}

function organizationLocaleForUi(uiLocale: string): string {
  const canonical = canonicalLocale(uiLocale)
  if (canonical && (LOCALE_OPTIONS as readonly string[]).includes(canonical)) return canonical
  const language = (canonical ?? uiLocale).split('-')[0]?.toLowerCase() ?? ''
  if (language === 'da') return 'da-DK'
  if (language === 'de') return 'de-DE'
  if (language === 'fr') return 'fr-FR'
  if (language === 'nl') return 'nl-NL'
  if (language === 'es') return 'es-ES'
  return 'en-US'
}

function OnboardingPage() {
  const { locale } = useI18n()
  const { lang } = Route.useSearch()
  return <I18nProvider locale={lang ?? locale}><OnboardingPageContent /></I18nProvider>
}

function OnboardingPageContent() {
  const { t, locale: uiLocale = 'en-US' } = useI18n()
  const countryNames = useMemo(() => new Intl.DisplayNames([uiLocale], { type: 'region' }), [uiLocale])
  const search = Route.useSearch()
  const target = loginReturnTarget(search)
  const returnDestination = loginReturnDestination(target ?? '/', search.lang)
  const navigate = useNavigate()
  const { isCloud } = useRuntimeDistribution()
  const { data: session } = useSession()
  const hasActiveOrg = Boolean(session?.session.activeOrganizationId)

  const [entryMode, setEntryMode] = useState<'lookup' | 'manual'>(isCloud ? 'lookup' : 'manual')
  const [lookupQuery, setLookupQuery] = useState('')
  const [lookupCompanies, setLookupCompanies] = useState<CvrLookupCompany[]>([])
  const [lookupMessage, setLookupMessage] = useState<string | null>(null)
  const [manualName, setManualName] = useState('')
  const [statusLoading, setStatusLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [orgAccessState, setOrgAccessState] = useState<OrganizationAccessState>({
    kind: 'create',
  })
  const [orgAccessLoading, setOrgAccessLoading] = useState(false)
  const [method, setMethod] = useState<CloudOnboardingMethod>('manual')
  const [hasSubmitted, setHasSubmitted] = useState(false)
  const [missingFields, setMissingFields] = useState<OnboardingMissingField[]>([])
  const [runtimeCapabilities, setRuntimeCapabilities] = useState<
    Pick<RuntimeCapabilities, 'onboardingAi'> | null
  >(null)
  const [values, setValues] = useState<CloudOnboardingValues>(() => ({
    ...DEFAULT_CLOUD_ONBOARDING_VALUES,
    locale: organizationLocaleForUi(uiLocale),
  }))
  // A country or locale edit before status loads must survive that response.
  const localeChoice = useRef<string | null>(null)
  const [manualOverrides, setManualOverrides] = useState<Record<AutoFillField, boolean>>({
    locale: false,
    timezone: false,
    defaultCurrency: false,
    taxRegime: false,
    pricesIncludeTax: false,
  })

  const invalidBusinessBasics = !values.companyName.trim() || !values.companyAddress.trim() ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.companyEmail.trim())

  const onboardingRules = getOnboardingRules({
    countryCode: values.countryCode,
    invoicingIdentity: values.invoicingIdentity,
    taxRegime: values.taxRegime,
  })

  const outstandingFields = missingFields.filter((field) => {
    if (field === 'primaryTaxId') return onboardingRules.requirePrimaryTaxId && !values.primaryTaxId.trim()
    if (field === 'invoiceNextNum' || field === 'quoteNextNum') return true
    return !values[field].trim()
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
            destination: isCloud ? loginReturnOnboarding(search) : returnDestination,
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
  }, [hasActiveOrg, isCloud, returnDestination, target, search.lang])

  useEffect(() => {
    if (!isCloud || !hasActiveOrg) {
      return
    }

    let cancelled = false
    setStatusLoading(true)

    trpc.onboarding.getStatus
      .query()
      .then(async (status) => {
        if (cancelled) {
          return
        }

        const selected = !status.isComplete && session?.user?.id && session.session.activeOrganizationId
          ? readSelectedCompany(session.user.id, session.session.activeOrganizationId)
          : null
        const uiOrganizationLocale = localeChoice.current ?? organizationLocaleForUi(uiLocale)
        if (selected) {
          const draft = await trpc.onboarding.saveDraft.mutate(selected.cvr
            ? {
                companyName: selected.name,
                companyAddress: selected.address,
                countryCode: 'DK',
                primaryTaxId: selected.cvr,
                primaryTaxIdScheme: 'cvr',
                locale: uiOrganizationLocale,
              }
            : {
                companyName: selected.name,
                primaryTaxId: null,
                locale: uiOrganizationLocale,
              })
          if (cancelled) return
          clearSelectedCompany(session!.user.id, session!.session.activeOrganizationId!)
          status = draft
        }
        if (status.values) {
          const parsed = parseCloudOnboardingValues(status.values)
          if (localeChoice.current) parsed.locale = localeChoice.current
          else if (selected || (!parsed.companyName.trim() && parsed.locale === 'da-DK')) {
            parsed.locale = organizationLocaleForUi(uiLocale)
          }
          if (!selected && !localeChoice.current && !parsed.companyName.trim() &&
            parsed.locale !== String(status.values.locale ?? '') && parsed.locale !== 'da-DK') {
            try {
              await trpc.onboarding.saveDraft.mutate({ locale: parsed.locale, primaryTaxId: null })
            } catch {
              // The field already shows the current language. The next visit can store it.
            }
          }
          setValues(parsed)
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
          // The layout may still hold an earlier "incomplete" answer, which would send us back here.
          invalidateAppLayoutSession()
          if (target || search.lang) loadPage(returnDestination)
          else navigate({ to: '/' })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(t('auth.onboarding.loadError'))
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
  }, [hasActiveOrg, isCloud, navigate, target, returnDestination, search.lang, uiLocale])

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
      if (key === 'locale') localeChoice.current = String(value)
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

    if (!manualOverrides.locale) localeChoice.current = defaults.locale
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

  async function createOrganizationFromCompanyName(name: string, company?: CvrLookupCompany) {
    setError(null)
    setSubmitting(true)
    let created: Awaited<ReturnType<typeof createNamedOrganization>>
    try {
      created = await createNamedOrganization({
        name,
        isSlugAvailable: async (slug) => {
          const checked = await authClient.organization.checkSlug({ slug })
          if (!checked.error) return checked.data?.status === true
          if (/slug already taken|already exists/i.test(checked.error.message ?? '')) return false
          throw new Error(checked.error.message ?? 'slug check failed')
        },
        create: async (body) => {
          const result = await authClient.organization.create(body)
          if (result.data?.id) return { ok: true, id: result.data.id }
          return { ok: false, message: result.error?.message ?? '' }
        },
      })
    } catch {
      setError(t('auth.onboarding.error'))
      setSubmitting(false)
      return
    }
    if (!created.ok) {
      setError(t('auth.onboarding.error'))
      setSubmitting(false)
      return
    }

    // The next page acts for the new organization; this page's requests still name the old one.
    if (session?.user?.id) {
      try {
        stageSelectedCompany(session.user.id, created.id, company ?? { name, address: '', cvr: '' })
      } catch {
        setError(t('auth.onboarding.error'))
        setSubmitting(false)
        return
      }
    }
    // Loads a new page acting for the new organization.
    const switched = await switchActiveOrganization(created.id, {
      destination: isCloud && target ? loginReturnOnboarding(search) : returnDestination,
    })
    if (switched?.error) {
      setError(switched.error.message ?? t('auth.onboarding.error'))
      setSubmitting(false)
    }
  }

  async function handleLookup(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLookupMessage(null)
    setLookupCompanies([])
    if (!isCloud) {
      setLookupMessage(t('auth.onboarding.lookup.unavailable'))
      return
    }
    setSubmitting(true)
    try {
      const result = await trpc.onboarding.searchCvr.query({ q: lookupQuery.trim() })
      setLookupCompanies(result.companies)
      setLookupMessage(result.available
        ? (result.companies.length ? null : t('auth.onboarding.lookup.empty'))
        : t('auth.onboarding.lookup.unavailable'))
    } catch {
      setLookupMessage(t('auth.onboarding.lookup.failed'))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleManualOrganization(e: React.FormEvent) {
    e.preventDefault()
    await createOrganizationFromCompanyName(manualName)
  }

  async function handleSelectOrganization(organizationId: string) {
    setError(null)
    setSubmitting(true)

    try {
      // Loads a new page acting for the selected organization.
      const switched = await switchActiveOrganization(organizationId, {
        destination: isCloud && target ? loginReturnOnboarding(search) : returnDestination,
      })
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
    setHasSubmitted(true)
    if (invalidBusinessBasics) return
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

      if (draft.missing?.length) {
        setSubmitting(false)
        return
      }

      await trpc.onboarding.completeManual.mutate({ method })
      // The layout must see onboarding as complete now, not after its reuse window.
      invalidateAppLayoutSession()
      if (target || search.lang) loadPage(returnDestination)
      else navigate({ to: '/' })
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : t('auth.onboarding.finish.error')
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
            <CardTitle className="text-2xl">
              {t(entryMode === 'manual' ? 'auth.onboarding.lookup.manualTitle' : 'auth.onboarding.lookup.title')}
            </CardTitle>
            <CardDescription>
              {t(entryMode === 'manual' ? 'auth.onboarding.lookup.manualDescription' : 'auth.onboarding.lookup.description')}
            </CardDescription>
          </CardHeader>
          {entryMode === 'manual' ? (
            <form onSubmit={(e) => void handleManualOrganization(e)}>
              <CardContent className="flex flex-col gap-4">
                {error && (
                  <p className="text-sm text-destructive" role="alert">
                    {error}
                  </p>
                )}
                <div className="flex flex-col gap-2">
                  <Label htmlFor="company-name">{t('auth.onboarding.field.companyName')}</Label>
                  <Input
                    id="company-name"
                    type="text"
                    placeholder={t('auth.onboarding.placeholder.orgName')}
                    value={manualName}
                    onChange={(e) => setManualName(e.target.value)}
                    required
                  />
                </div>
              </CardContent>
              <CardFooter className="flex flex-col gap-2">
                <Button type="submit" className="w-full" disabled={submitting}>
                  {submitting ? t('auth.onboarding.submitting') : t('auth.onboarding.submit')}
                </Button>
                {isCloud && <Button
                  type="button"
                  variant="link"
                  className="w-full"
                  disabled={submitting}
                  onClick={() => {
                    setEntryMode('lookup')
                    setError(null)
                  }}
                >
                  {t('auth.onboarding.lookup.manualBack')}
                </Button>}
              </CardFooter>
            </form>
          ) : (
            <form className="flex flex-col gap-6" onSubmit={(e) => void handleLookup(e)}>
              <CardContent className="flex flex-col gap-4">
                {error && (
                  <p className="text-sm text-destructive" role="alert">
                    {error}
                  </p>
                )}
                <div className="flex flex-col gap-2">
                  <Label htmlFor="cvr-query">{t('auth.onboarding.lookup.query')}</Label>
                  <Input
                    id="cvr-query"
                    type="text"
                    placeholder={t('auth.onboarding.lookup.placeholder')}
                    value={lookupQuery}
                    maxLength={120}
                    onChange={(e) => setLookupQuery(e.target.value)}
                    required
                    minLength={3}
                  />
                </div>
                {lookupMessage && (
                  <p className="text-sm text-muted-foreground" role="status">
                    {lookupMessage}
                  </p>
                )}
                {lookupCompanies.map((company) => (
                  <Button
                    key={company.cvr}
                    type="button"
                    variant="outline"
                    className="h-auto w-full flex-col items-start gap-1 py-3"
                    disabled={submitting}
                    onClick={() => void createOrganizationFromCompanyName(company.name, company)}
                  >
                    <span>{t('auth.onboarding.lookup.confirm', { company: company.name })}</span>
                    <span className="text-xs font-normal text-muted-foreground">
                      {company.cvr} · {company.address}
                    </span>
                  </Button>
                ))}
              </CardContent>
              <CardFooter className="flex flex-col gap-2">
                <Button type="submit" className="w-full" disabled={submitting}>
                  {submitting ? t('auth.onboarding.lookup.searching') : t('auth.onboarding.lookup.submit')}
                </Button>
                <Button
                  type="button"
                  variant="link"
                  className="w-full"
                  disabled={submitting}
                  onClick={() => {
                    setEntryMode('manual')
                    setError(null)
                  }}
                >
                  {t('auth.onboarding.lookup.manual')}
                </Button>
              </CardFooter>
            </form>
          )}
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
            <Button type="button" className="w-full" onClick={() => target || search.lang ? loadPage(returnDestination) : navigate({ to: '/' })}>
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
          <CardTitle className="text-2xl">{t('auth.onboarding.finish.title')}</CardTitle>
          <CardDescription>
            {t('auth.onboarding.finish.description')}
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleCompleteCloudOnboarding} noValidate>
          <CardContent className="space-y-6">
            {error && (
              <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
                {error}
              </p>
            )}

            {statusLoading && (
              <p className="text-sm text-muted-foreground">{t('auth.onboarding.loading')}</p>
            )}

            <div className={`grid gap-3 ${runtimeCapabilities?.onboardingAi.enabled ? 'md:grid-cols-2' : ''}`}>
              <button
                type="button"
                onClick={() => setMethod('manual')}
                className={`rounded-lg border p-4 text-left ${method === 'manual' ? 'border-primary bg-primary/5' : 'border-border'}`}
              >
                <p className="text-sm font-semibold">{t('auth.onboarding.manual.title')}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t('auth.onboarding.manual.help')}</p>
              </button>
              {runtimeCapabilities?.onboardingAi.enabled ? (
                <button
                  type="button"
                  onClick={() => setMethod('ai')}
                  className={`rounded-lg border p-4 text-left ${method === 'ai' ? 'border-primary bg-primary/5' : 'border-border'}`}
                >
                  <p className="text-sm font-semibold">{t('auth.onboarding.ai.cardTitle')}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t('auth.onboarding.ai.help')}
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

            {hasSubmitted && invalidBusinessBasics ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
                {t('auth.onboarding.validation.businessBasics')}
              </p>
            ) : hasSubmitted && outstandingFields.length > 0 ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
                {t('auth.onboarding.validation.required', { fields: outstandingFields.map((field) => t(`auth.onboarding.field.${field}`)).join(', ') })}
              </p>
            ) : null}

            <section className="space-y-4 rounded-lg border border-border p-4">
              <div className="space-y-1">
                <h2 className="text-lg font-semibold">{t('auth.onboarding.basics.title')}</h2>
                <p className="text-sm text-muted-foreground">
                  {t('auth.onboarding.basics.help')}
                </p>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="companyName">{t('auth.onboarding.field.companyName')}</Label>
                  <Input
                    id="companyName"
                    aria-invalid={hasSubmitted && (!values.companyName.trim())}
                    value={values.companyName}
                    onChange={(e) => updateValue('companyName', e.target.value)}
                    required
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="companyEmail">{t('auth.onboarding.field.companyEmail')}</Label>
                  <Input
                    id="companyEmail"
                    aria-invalid={hasSubmitted && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.companyEmail.trim()))}
                    type="email"
                    value={values.companyEmail}
                    onChange={(e) => updateValue('companyEmail', e.target.value)}
                    required
                  />
                </div>
                <div className="flex flex-col gap-2 md:col-span-2">
                  <Label htmlFor="companyAddress">{t('auth.onboarding.field.companyAddress')}</Label>
                  <Input
                    id="companyAddress"
                    aria-invalid={hasSubmitted && (!values.companyAddress.trim())}
                    value={values.companyAddress}
                    onChange={(e) => updateValue('companyAddress', e.target.value)}
                    required
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="countryCode">{t('auth.onboarding.field.countryCode')}</Label>
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
                        {countryNames.of(country.code) ?? country.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-2">
                <Label>{t('auth.onboarding.identity.label')}</Label>
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
                    <p className="text-sm font-semibold">{t('auth.onboarding.identity.individual')}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('auth.onboarding.identity.individualHelp')}
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
                      {t('auth.onboarding.identity.business')}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t('auth.onboarding.identity.businessHelp')}
                    </p>
                  </button>
                </div>
              </div>
            </section>

            <section className="space-y-4 rounded-lg border border-border p-4">
              <div className="space-y-1">
                <h2 className="text-lg font-semibold">{t('auth.onboarding.defaults.title')}</h2>
                <p className="text-sm text-muted-foreground">
                  {t('auth.onboarding.defaults.help')}
                </p>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="locale">{t('auth.onboarding.field.locale')}</Label>
                  <select
                    id="locale"
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    value={values.locale}
                    onChange={(e) => updateValue('locale', e.target.value)}
                  >
                    {localeOptionsIncluding(values.locale).map((locale) => (
                      <option key={locale} value={locale}>
                        {locale === 'da-DK' ? t('auth.onboarding.locale.da') : locale === 'en-US' ? t('auth.onboarding.locale.en') : locale}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="timezone">{t('auth.onboarding.field.timezone')}</Label>
                  <Input
                    id="timezone"
                    aria-invalid={hasSubmitted && (!values.timezone.trim())}
                    value={values.timezone}
                    onChange={(e) => updateValue('timezone', e.target.value)}
                    required
                  />
                  {values.timezone === 'Europe/Copenhagen' && <p className="text-xs text-muted-foreground">{t('auth.onboarding.city.copenhagen')}</p>}
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="defaultCurrency">{t('auth.onboarding.field.defaultCurrency')}</Label>
                  <select
                    id="defaultCurrency"
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    value={values.defaultCurrency}
                    onChange={(e) => updateValue('defaultCurrency', e.target.value)}
                  >
                    {CURRENCIES.map((currency) => (
                      <option key={currency.value} value={currency.value}>
                        {t(`auth.onboarding.currency.${currency.value}`)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="taxRegime">{t('auth.onboarding.field.taxRegime')}</Label>
                  <select
                    id="taxRegime"
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                    value={values.taxRegime}
                    onChange={(e) => updateValue('taxRegime', e.target.value as CloudTaxRegime)}
                  >
                    {TAX_REGIMES.map((regime) => (
                      <option key={regime.value} value={regime.value}>
                        {regime.value === 'eu_vat' ? t(values.countryCode === 'DK' ? 'auth.onboarding.regime.euVat' : 'auth.onboarding.regime.euVatGeneric') : regime.value === 'us_sales_tax' ? t('auth.onboarding.regime.usSalesTax') : t('auth.onboarding.regime.custom')}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </section>

            <section className="space-y-4 rounded-lg border border-border p-4">
              <div className="space-y-1">
                <h2 className="text-lg font-semibold">{t('auth.onboarding.compliance.title')}</h2>
                <p className="text-sm text-muted-foreground">
                  {t('auth.onboarding.compliance.help')}
                </p>
              </div>

              {onboardingRules.showPrimaryTaxId ? (
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="primaryTaxId">
                      {uiLocale.startsWith('da') ? values.countryCode === 'DK' ? t('auth.onboarding.primary.dkLabel') : t('auth.onboarding.primary.euLabel') : onboardingRules.primaryTaxIdCopy.label}
                    </Label>
                    <Input
                      id="primaryTaxId"
                      aria-invalid={hasSubmitted && (onboardingRules.requirePrimaryTaxId && !values.primaryTaxId.trim())}
                      value={values.primaryTaxId}
                      onChange={(e) => updateValue('primaryTaxId', e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      {uiLocale.startsWith('da') ? values.countryCode === 'DK' ? t('auth.onboarding.primary.dkHelp') : t('auth.onboarding.primary.euHelp') : onboardingRules.primaryTaxIdCopy.help}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t('auth.onboarding.compliance.none')}
                </p>
              )}
            </section>

            <details className="rounded-lg border border-border p-4">
              <summary className="cursor-pointer list-none text-lg font-semibold">
                {t('auth.onboarding.advanced.title')}
              </summary>
              <p className="mt-2 text-sm text-muted-foreground">
                {t('auth.onboarding.advanced.help')}
              </p>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="invoicePrefix">{t('auth.onboarding.field.invoicePrefix')}</Label>
                  <Input
                    id="invoicePrefix"
                    aria-invalid={hasSubmitted && (!values.invoicePrefix.trim())}
                    value={values.invoicePrefix}
                    onChange={(e) => updateValue('invoicePrefix', e.target.value.toUpperCase())}
                    required
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="quotePrefix">{t('auth.onboarding.field.quotePrefix')}</Label>
                  <Input
                    id="quotePrefix"
                    aria-invalid={hasSubmitted && (!values.quotePrefix.trim())}
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
                  {t('auth.onboarding.pricesIncludeTax')}
                </label>
              </div>
            </details>
          </CardContent>
          <CardFooter className="pt-3">
            <Button type="submit" className="w-full" disabled={submitting || statusLoading}>
              {submitting ? t('auth.onboarding.finish.submitting') : t('auth.onboarding.finish.submit')}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  )
}
