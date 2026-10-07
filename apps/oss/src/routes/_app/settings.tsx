import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useMemo, useState } from "react"
import { trpc } from "../../trpc/client"
import { authClient, useSession } from "../../lib/auth-client"
import {
  type SettingsFormValidationError,
  validateSettingsFormInput,
} from "../../lib/validation/settings-form"
import {
  COUNTRY_OPTIONS,
  countryOptionsIncluding,
  localeOptionsIncluding,
  TAX_REGIMES,
} from "../../lib/compliance/countries"
import { Button } from "../../components/ui/button"
import { Input } from "../../components/ui/input"
import { Label } from "../../components/ui/label"
import { Textarea } from "../../components/ui/textarea"
import { Badge } from "../../components/ui/badge"
import {
  DocumentEmailSendingCard,
  type DocumentSendingState,
} from "../../components/settings/document-email-sending-card"
import { EmailDeliveryCard } from "../../components/settings/email-delivery-card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "../../components/ui/card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../components/ui/alert-dialog"
import { Settings, UserPlus, X, Crown, User, Eye } from "lucide-react"
import type { TranslationKey } from "../../lib/i18n/messages"
import { useI18n } from "../../lib/i18n/react"
import { shouldAutoLoadOpenRouterModels } from "./-settings.helpers"
import { getOnboardingRules, type OnboardingInvoicingIdentity } from "../../lib/onboarding/rules"
import { AgentKeysCard } from "../../components/settings/agent-keys-card"
import { AuditLogCard } from "../../components/settings/audit-log-card"
import { ReminderPolicyCard } from "../../components/settings/reminder-policy-card"

const settingsValidationMessages: Record<SettingsFormValidationError, TranslationKey> = {
  invalid_timezone: "settings.validation.invalidTimezone",
  invalid_tax_rate: "settings.validation.invalidTaxRate",
  invalid_company_email: "settings.validation.invalidCompanyEmail",
  invalid_company_phone: "settings.validation.invalidCompanyPhone",
  invalid_invoice_prefix: "settings.validation.invalidInvoicePrefix",
  invalid_quote_prefix: "settings.validation.invalidQuotePrefix",
  invalid_credit_note_prefix: "settings.validation.invalidCreditNotePrefix",
}

export const Route = createFileRoute("/_app/settings")({
  component: SettingsPage,
})

type OrgMember = {
  id: string
  role: string
  user: { id: string; name: string; email: string; image?: string | null }
}

type OrgInvitation = {
  id: string
  email: string
  role: string
  status: string
  expiresAt: Date
}

const ROLE_CONFIG: Record<string, { key: "admin" | "member" | "accountant"; icon: typeof User }> = {
  admin: { key: "admin", icon: Crown },
  member: { key: "member", icon: User },
  accountant: { key: "accountant", icon: Eye },
}

function RoleBadge({
  role,
  label,
}: {
  role: string
  label: string
}) {
  const config = ROLE_CONFIG[role] ?? ROLE_CONFIG.member
  const Icon = config.icon
  return (
    <Badge variant="secondary" className="gap-1">
      <Icon className="size-3" />
      {label}
    </Badge>
  )
}

type SettingsData = {
  id: string
  countryCode: string
  locale: string
  timezone: string
  baseCurrency: string
  baseCurrencyLocked: boolean
  defaultCurrency: string
  onboardingInvoicingIdentity?: OnboardingInvoicingIdentity | null
  taxRegime: "us_sales_tax" | "eu_vat" | "custom"
  pricesIncludeTax: boolean
  currency: string
  taxRate: number | null
  companyName: string | null
  companyAddress: string | null
  companyEmail: string | null
  companyPhone: string | null
  companyLogo: string | null
  invoicePrefix: string
  invoiceNextNum: number
  quotePrefix: string
  quoteNextNum: number
  creditNotePrefix: string
  creditNoteNextNum: number
  aiByokConfigured: boolean
  aiOpenRouterModel: string
  stripeByokConfigured: boolean
  stripePublishableKey: string | null
  emailDelivery: {
    managed: boolean
    configured: boolean
    available: boolean
    sender: string
    missing: string[]
    status: "configured" | "missing_configuration" | "managed" | "managed_unavailable"
  }
  documentSending: DocumentSendingState
  primaryTaxId: string | null
  primaryTaxIdScheme: string | null
}

const CURRENCIES = [
  { value: "USD", label: "USD - US Dollar" },
  { value: "DKK", label: "DKK - Danish Krone" },
  { value: "EUR", label: "EUR - Euro" },
  { value: "GBP", label: "GBP - British Pound" },
  { value: "CAD", label: "CAD - Canadian Dollar" },
  { value: "AUD", label: "AUD - Australian Dollar" },
]

const OPENROUTER_FALLBACK_MODELS = [
  "openai/gpt-4o-mini",
  "openai/gpt-4.1-mini",
  "anthropic/claude-3.5-sonnet",
  "google/gemini-2.0-flash-001",
]

const LOGO_MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024
const LOGO_FILE_ACCEPT = "image/png,image/jpeg,image/webp,image/svg+xml"
const HTTP_URL_REGEX = /^https?:\/\/.+/i

function isDataImageLogo(value: string) {
  return value.startsWith("data:image/")
}

function isHttpLogoUrl(value: string) {
  return HTTP_URL_REGEX.test(value)
}

function SettingsPage() {
  const { t } = useI18n()
  const { data: session } = useSession()
  const [settings, setSettings] = useState<SettingsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [countryCode, setCountryCode] = useState("US")
  const [locale, setLocale] = useState("en-US")
  const [timezone, setTimezone] = useState("UTC")
  const [baseCurrency, setBaseCurrency] = useState("USD")
  const [defaultCurrency, setDefaultCurrency] = useState("USD")
  const [invoicingIdentity, setInvoicingIdentity] = useState<OnboardingInvoicingIdentity>("registered_business")
  const [taxRegime, setTaxRegime] = useState<"us_sales_tax" | "eu_vat" | "custom">("us_sales_tax")
  const [pricesIncludeTax, setPricesIncludeTax] = useState(false)
  const [primaryTaxId, setPrimaryTaxId] = useState("")
  const [primaryTaxIdScheme, setPrimaryTaxIdScheme] = useState("vat")
  const [companyLogo, setCompanyLogo] = useState("")
  const [companyLogoUrlInput, setCompanyLogoUrlInput] = useState("")
  const [logoError, setLogoError] = useState<string | null>(null)
  const [aiOpenRouterModel, setAiOpenRouterModel] = useState("openai/gpt-4o-mini")
  const [clearAiOpenRouterApiKey, setClearAiOpenRouterApiKey] = useState(false)
  const [clearStripeSecretKey, setClearStripeSecretKey] = useState(false)
  const [clearStripeWebhookSecret, setClearStripeWebhookSecret] = useState(false)
  const [openRouterModels, setOpenRouterModels] = useState<string[]>(OPENROUTER_FALLBACK_MODELS)
  const [loadingOpenRouterModels, setLoadingOpenRouterModels] = useState(false)
  const [openRouterModelsError, setOpenRouterModelsError] = useState<string | null>(null)
  const [documentSendingDomainInput, setDocumentSendingDomainInput] = useState("")
  const [documentSendingBusy, setDocumentSendingBusy] = useState(false)
  const [documentSendingError, setDocumentSendingError] = useState<string | null>(null)
  const [documentSendingSuccess, setDocumentSendingSuccess] = useState<string | null>(null)

  // Team members state
  const [members, setMembers] = useState<OrgMember[]>([])
  const [invitations, setInvitations] = useState<OrgInvitation[]>([])
  const [teamLoading, setTeamLoading] = useState(true)
  const [inviteEmail, setInviteEmail] = useState("")
  const [inviteRole, setInviteRole] = useState("member")
  const [inviting, setInviting] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const countryDisplayNames = useMemo(
    () => new Intl.DisplayNames([locale || "en-US"], { type: "region" }),
    [locale]
  )
  const currencyDisplayNames = useMemo(
    () => new Intl.DisplayNames([locale || "en-US"], { type: "currency" }),
    [locale]
  )
  const languageDisplayNames = useMemo(
    () => new Intl.DisplayNames([locale || "en-US"], { type: "language" }),
    [locale]
  )
  const taxRules = getOnboardingRules({
    countryCode,
    invoicingIdentity,
    taxRegime,
  })

  useEffect(() => {
    trpc.settings.get
      .query()
      .then((data) => {
        const nextSettings = data as SettingsData

        setSettings(nextSettings)
        setCountryCode(nextSettings.countryCode)
        setLocale(nextSettings.locale)
        setTimezone(nextSettings.timezone)
        setBaseCurrency(nextSettings.baseCurrency)
        setDefaultCurrency(nextSettings.defaultCurrency || nextSettings.currency)
        setInvoicingIdentity(
          nextSettings.onboardingInvoicingIdentity ?? "registered_business"
        )
        setTaxRegime(nextSettings.taxRegime)
        setPricesIncludeTax(nextSettings.pricesIncludeTax)
        setPrimaryTaxId(nextSettings.primaryTaxId ?? "")
        setPrimaryTaxIdScheme(nextSettings.primaryTaxIdScheme ?? "vat")
        const existingLogo = nextSettings.companyLogo ?? ""
        setCompanyLogo(existingLogo)
        setCompanyLogoUrlInput(isDataImageLogo(existingLogo) ? "" : existingLogo)
        const nextAiOpenRouterModel =
          nextSettings.aiOpenRouterModel || "openai/gpt-4o-mini"
        setAiOpenRouterModel(nextAiOpenRouterModel)
        setDocumentSendingDomainInput(
          nextSettings.documentSending.requestedDomain ?? ""
        )

        if (
          shouldAutoLoadOpenRouterModels(
            nextAiOpenRouterModel,
            OPENROUTER_FALLBACK_MODELS
          )
        ) {
          void loadOpenRouterModels()
        }
      })
      .catch(() =>
        setError(t("settings.error.loadFailed"))
      )
      .finally(() => setLoading(false))
  }, [t])

  async function loadOpenRouterModels() {
    setLoadingOpenRouterModels(true)
    setOpenRouterModelsError(null)
    try {
      const result = await trpc.ai.listModels.query()
      const nextModels: string[] = Array.isArray(result.models)
        ? result.models.flatMap((model) =>
            typeof model === "string" ? [model] : []
          )
        : []

      if (nextModels.length > 0) {
        setOpenRouterModels(nextModels)
      }
    } catch {
      setOpenRouterModelsError(
        t("settings.error.loadModelsFailed")
      )
    } finally {
      setLoadingOpenRouterModels(false)
    }
  }

  useEffect(() => {
    async function loadTeam() {
      const org = await authClient.organization.getFullOrganization()
      if (org.data) {
        setMembers((org.data.members ?? []) as OrgMember[])
        setInvitations(
          ((org.data.invitations ?? []) as OrgInvitation[]).filter(
            (i) => i.status === "pending"
          )
        )
      }
      setTeamLoading(false)
    }
    loadTeam()
  }, [])

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    setInviteError(null)
    setInviting(true)
    const result = await authClient.organization.inviteMember({
      email: inviteEmail,
      role: inviteRole as "member" | "admin" | "accountant",
    })
    if (result.error) {
      setInviteError(
        result.error.message ??
          t("settings.error.inviteFailed")
      )
    } else if (result.data) {
      setInvitations((prev) => [...prev, result.data as OrgInvitation])
      setInviteEmail("")
    }
    setInviting(false)
  }

  async function handleRemoveMember(memberId: string) {
    await authClient.organization.removeMember({ memberIdOrEmail: memberId })
    setMembers((prev) => prev.filter((m) => m.id !== memberId))
  }

  async function handleCancelInvite(invitationId: string) {
    await authClient.organization.cancelInvitation({ invitationId })
    setInvitations((prev) => prev.filter((i) => i.id !== invitationId))
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    setSuccess(false)
    setSaving(true)

    const form = new FormData(e.currentTarget)
    const timezoneInput = ((form.get("timezone") as string) || timezone).trim() || "UTC"
    const taxRateRaw = ((form.get("taxRate") as string) || "").trim()
    const companyNameInput = ((form.get("companyName") as string) || "").trim()
    const companyAddressInput = ((form.get("companyAddress") as string) || "").trim()
    const companyEmailInput = ((form.get("companyEmail") as string) || "").trim()
    const companyPhoneInput = ((form.get("companyPhone") as string) || "").trim()
    const invoicePrefixInput = ((form.get("invoicePrefix") as string) || "").trim()
    const quotePrefixInput = ((form.get("quotePrefix") as string) || "").trim()
    const creditNotePrefixInput = ((form.get("creditNotePrefix") as string) || "").trim()
    const aiOpenRouterModelInput = aiOpenRouterModel.trim()
    const aiOpenRouterApiKeyInput = ((form.get("aiOpenRouterApiKey") as string) || "").trim()
    const stripePublishableKeyInput = ((form.get("stripePublishableKey") as string) || "").trim()
    const stripeSecretKeyInput = ((form.get("stripeSecretKey") as string) || "").trim()
    const stripeWebhookSecretInput = ((form.get("stripeWebhookSecret") as string) || "").trim()
    const normalizedCompanyLogo = companyLogo.trim()

    if (
      normalizedCompanyLogo &&
      !isDataImageLogo(normalizedCompanyLogo) &&
      !isHttpLogoUrl(normalizedCompanyLogo)
    ) {
      setSaving(false)
      setError(t("settings.error.logoInvalid"))
      return
    }

    const formValidationError = validateSettingsFormInput({
      timezone: timezoneInput,
      taxRateRaw,
      companyEmail: companyEmailInput,
      companyPhone: companyPhoneInput,
      invoicePrefix: invoicePrefixInput,
      quotePrefix: quotePrefixInput,
      creditNotePrefix: creditNotePrefixInput,
    })

    if (formValidationError) {
      setSaving(false)
      setError(t(settingsValidationMessages[formValidationError]))
      return
    }

    try {
      await trpc.settings.update.mutate({
        countryCode,
        locale,
        timezone: timezoneInput,
        defaultCurrency,
        baseCurrency,
        taxRegime,
        pricesIncludeTax,
        primaryTaxId: primaryTaxId || undefined,
        primaryTaxIdScheme,
        currency: defaultCurrency,
        taxRate: taxRateRaw ? parseFloat(taxRateRaw) : null,
        companyName: companyNameInput || undefined,
        companyAddress: companyAddressInput || undefined,
        companyEmail: companyEmailInput || undefined,
        companyPhone: companyPhoneInput || undefined,
        companyLogo: normalizedCompanyLogo || null,
        invoicePrefix: invoicePrefixInput || undefined,
        quotePrefix: quotePrefixInput || undefined,
        creditNotePrefix: creditNotePrefixInput || undefined,
        onboardingInvoicingIdentity: invoicingIdentity,
        aiOpenRouterModel: aiOpenRouterModelInput || undefined,
        aiOpenRouterApiKey: aiOpenRouterApiKeyInput || undefined,
        clearAiOpenRouterApiKey,
        stripePublishableKey: stripePublishableKeyInput || undefined,
        stripeSecretKey: stripeSecretKeyInput || undefined,
        stripeWebhookSecret: stripeWebhookSecretInput || undefined,
        clearStripeSecretKey,
        clearStripeWebhookSecret,
      })
      setTimezone(timezoneInput)
      setClearAiOpenRouterApiKey(false)
      setClearStripeSecretKey(false)
      setClearStripeWebhookSecret(false)
      setSuccess(true)
      setTimeout(() => setSuccess(false), 3000)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("settings.error.saveFailed")
      )
    } finally {
      setSaving(false)
    }
  }

  async function handleLogoFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    setLogoError(null)
    setError(null)

    if (!file.type.startsWith("image/")) {
      setLogoError(t("settings.error.logoType"))
      event.target.value = ""
      return
    }

    if (file.size > LOGO_MAX_FILE_SIZE_BYTES) {
      setLogoError(t("settings.error.logoTooLarge"))
      event.target.value = ""
      return
    }

    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result ?? ""))
        reader.onerror = () => reject(new Error("Failed to read file"))
        reader.readAsDataURL(file)
      })
      setCompanyLogo(dataUrl)
      setCompanyLogoUrlInput("")
    } catch {
      setLogoError(t("settings.error.logoReadFailed"))
    } finally {
      event.target.value = ""
    }
  }

  async function handleConfigureDocumentSendingDomain() {
    setDocumentSendingError(null)
    setDocumentSendingSuccess(null)
    setDocumentSendingBusy(true)

    try {
      const documentSending = await trpc.settings.configureDocumentSendingDomain.mutate({
        domain: documentSendingDomainInput.trim(),
      })
      setSettings((current) =>
        current
          ? {
              ...current,
              documentSending,
            }
          : current
      )
      setDocumentSendingDomainInput(documentSending.requestedDomain ?? "")
      setDocumentSendingSuccess(t("settings.documentSending.success.configured"))
    } catch (err) {
      setDocumentSendingError(
        err instanceof Error
          ? err.message
          : t("settings.documentSending.error.configureFailed")
      )
    } finally {
      setDocumentSendingBusy(false)
    }
  }

  async function handleRefreshDocumentSendingDomain() {
    setDocumentSendingError(null)
    setDocumentSendingSuccess(null)
    setDocumentSendingBusy(true)

    try {
      const documentSending = await trpc.settings.refreshDocumentSendingDomain.mutate()
      setSettings((current) =>
        current
          ? {
              ...current,
              documentSending,
            }
          : current
      )
      setDocumentSendingSuccess(t("settings.documentSending.success.refreshed"))
    } catch (err) {
      setDocumentSendingError(
        err instanceof Error
          ? err.message
          : t("settings.documentSending.error.refreshFailed")
      )
    } finally {
      setDocumentSendingBusy(false)
    }
  }

  async function handleDisableDocumentSendingDomain() {
    setDocumentSendingError(null)
    setDocumentSendingSuccess(null)
    setDocumentSendingBusy(true)

    try {
      const documentSending = await trpc.settings.disableDocumentSendingDomain.mutate()
      setSettings((current) =>
        current
          ? {
              ...current,
              documentSending,
            }
          : current
      )
      setDocumentSendingDomainInput("")
      setDocumentSendingSuccess(t("settings.documentSending.success.disabled"))
    } catch (err) {
      setDocumentSendingError(
        err instanceof Error
          ? err.message
          : t("settings.documentSending.error.disableFailed")
      )
    } finally {
      setDocumentSendingBusy(false)
    }
  }

  function handleCompanyLogoUrlChange(event: React.ChangeEvent<HTMLInputElement>) {
    const nextValue = event.target.value
    setCompanyLogoUrlInput(nextValue)
    setLogoError(null)
    const trimmed = nextValue.trim()
    if (trimmed) {
      setCompanyLogo(trimmed)
      return
    }
    if (!isDataImageLogo(companyLogo)) {
      setCompanyLogo("")
    }
  }

  function clearCompanyLogo() {
    setCompanyLogo("")
    setCompanyLogoUrlInput("")
    setLogoError(null)
  }

  if (loading) {
    return (
      <div className="p-6">
        <div className="flex items-center gap-2 mb-6">
          <Settings className="size-6" />
          <h1 className="text-2xl font-bold">{t("settings.title")}</h1>
        </div>
        <p className="text-muted-foreground">{t("settings.loading")}</p>
      </div>
    )
  }

  if (!settings) {
    return (
      <div className="p-6">
        <div className="flex items-center gap-2 mb-6">
          <Settings className="size-6" />
          <h1 className="text-2xl font-bold">{t("settings.title")}</h1>
        </div>
        <p className="text-destructive">
          {error ?? t("settings.error.loadFailed")}
        </p>
      </div>
    )
  }

  return (
    <div className="p-6 max-w-2xl">
      <div className="flex items-center gap-2 mb-6">
        <Settings className="size-6" />
        <h1 className="text-2xl font-bold">{t("settings.title")}</h1>
      </div>

      <form onSubmit={handleSubmit} className="grid gap-6">
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        {success && (
          <p className="text-sm text-green-600" role="status">
            {t("settings.success.saved")}
          </p>
        )}

        {/* Company Information */}
        <Card>
          <CardHeader>
            <CardTitle>{t("settings.section.company.title")}</CardTitle>
            <CardDescription>
              {t("settings.section.company.description")}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="companyName">{t("settings.companyName.label")}</Label>
              <Input
                id="companyName"
                name="companyName"
                maxLength={120}
                placeholder={t("settings.companyName.placeholder")}
                defaultValue={settings.companyName ?? ""}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="companyAddress">{t("settings.companyAddress.label")}</Label>
              <Textarea
                id="companyAddress"
                name="companyAddress"
                placeholder={t("settings.companyAddress.placeholder")}
                rows={3}
                maxLength={240}
                defaultValue={settings.companyAddress ?? ""}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="companyEmail">{t("settings.companyEmail.label")}</Label>
                <Input
                  id="companyEmail"
                  name="companyEmail"
                  type="email"
                  maxLength={254}
                  placeholder={t("settings.companyEmail.placeholder")}
                  defaultValue={settings.companyEmail ?? ""}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="companyPhone">{t("settings.companyPhone.label")}</Label>
                <Input
                  id="companyPhone"
                  name="companyPhone"
                  maxLength={40}
                  pattern="^\+?[0-9()\-\s.]{6,20}$"
                  title={t("settings.companyPhone.title")}
                  placeholder={t("settings.companyPhone.placeholder")}
                  defaultValue={settings.companyPhone ?? ""}
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="companyLogoUrl">{t("settings.companyLogo.label")}</Label>
              <Input
                id="companyLogoUrl"
                type="url"
                maxLength={2000}
                placeholder={t("settings.companyLogo.placeholder")}
                value={companyLogoUrlInput}
                onChange={handleCompanyLogoUrlChange}
              />
              <p className="text-xs text-muted-foreground">
                {t("settings.companyLogo.help")}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="file"
                  accept={LOGO_FILE_ACCEPT}
                  onChange={handleLogoFileChange}
                  className="block w-full max-w-sm text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-2 file:text-sm file:font-medium file:text-foreground hover:file:bg-muted/80"
                />
                {companyLogo && (
                  <Button type="button" variant="outline" size="sm" onClick={clearCompanyLogo}>
                    {t("settings.companyLogo.remove")}
                  </Button>
                )}
              </div>
              {logoError && <p className="text-xs text-destructive">{logoError}</p>}
              {companyLogo && (
                <div className="rounded-md border bg-muted/20 p-3">
                  <img
                    src={companyLogo}
                    alt={t("settings.companyLogo.previewAlt")}
                    className="h-14 w-auto max-w-52 object-contain"
                  />
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Billing Defaults */}
        <Card>
          <CardHeader>
            <CardTitle>{t("settings.section.localization.title")}</CardTitle>
            <CardDescription>
              {t("settings.section.localization.description")}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="countryCode">{t("settings.country.label")}</Label>
                <Select
                  value={countryCode}
                  onValueChange={(nextCountry) => {
                    setCountryCode(nextCountry)
                    const preset = COUNTRY_OPTIONS.find((item) => item.code === nextCountry)
                    if (preset) {
                      setLocale(preset.defaultLocale)
                      setDefaultCurrency(preset.defaultCurrency)
                      if (!settings.baseCurrencyLocked) setBaseCurrency(preset.defaultCurrency)
                    }
                  }}
                >
                  <SelectTrigger id="countryCode">
                    <SelectValue placeholder={t("settings.country.placeholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {countryOptionsIncluding(settings?.countryCode).map((country) => (
                      <SelectItem key={country.code} value={country.code}>
                        {countryDisplayNames.of(country.code) ?? country.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="locale">{t("settings.locale.label")}</Label>
                <Select value={locale} onValueChange={setLocale}>
                  <SelectTrigger id="locale">
                    <SelectValue placeholder={t("settings.locale.placeholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {localeOptionsIncluding(settings?.locale).map((item) => (
                      <SelectItem key={item} value={item}>
                        {`${item} — ${languageDisplayNames.of(item.split("-")[0] ?? item) ?? item}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="timezone">{t("settings.timezone.label")}</Label>
                <Input
                  id="timezone"
                  name="timezone"
                  maxLength={64}
                  placeholder="UTC"
                  defaultValue={timezone}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="taxRegime">{t("settings.taxRegime.label")}</Label>
                <Select value={taxRegime} onValueChange={(value) => setTaxRegime(value as "us_sales_tax" | "eu_vat" | "custom")}>
                  <SelectTrigger id="taxRegime">
                    <SelectValue placeholder={t("settings.taxRegime.placeholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {TAX_REGIMES.map((regime) => (
                      <SelectItem key={regime.value} value={regime.value}>
                        {regime.value === "us_sales_tax"
                          ? t("settings.taxRegime.usSalesTax")
                          : regime.value === "eu_vat"
                            ? t("settings.taxRegime.euVat")
                            : t("settings.taxRegime.custom")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={pricesIncludeTax}
                onChange={(event) => setPricesIncludeTax(event.target.checked)}
              />
              {t("settings.pricesIncludeTax")}
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="grid gap-2">
                {taxRules.showPrimaryTaxId ? (
                  <>
                    <Label htmlFor="primaryTaxId">{taxRules.primaryTaxIdCopy.label}</Label>
                    <Input
                      id="primaryTaxId"
                      name="primaryTaxId"
                      maxLength={40}
                      placeholder={taxRules.primaryTaxIdCopy.label}
                      value={primaryTaxId}
                      onChange={(event) => setPrimaryTaxId(event.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      {taxRules.primaryTaxIdCopy.help}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-sm font-medium">Tax ID</p>
                    <p className="text-sm text-muted-foreground">
                      No tax ID required for this tax setup.
                    </p>
                  </>
                )}
              </div>
              {taxRules.showPrimaryTaxId ? (
                <div className="grid gap-2">
                  <Label htmlFor="primaryTaxIdScheme">{t("settings.primaryTaxIdScheme.label")}</Label>
                  <Select value={primaryTaxIdScheme} onValueChange={setPrimaryTaxIdScheme}>
                    <SelectTrigger id="primaryTaxIdScheme">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {taxRules.primaryTaxIdSchemes.map((option) => (
                        <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                      ))}
                      {primaryTaxIdScheme !== "other" &&
                      !taxRules.primaryTaxIdSchemes.some((option) => option.value === primaryTaxIdScheme) ? (
                        <SelectItem value={primaryTaxIdScheme}>{primaryTaxIdScheme.toUpperCase()}</SelectItem>
                      ) : null}
                      <SelectItem value="other">{t("settings.primaryTaxIdScheme.other")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>

        {/* Billing Defaults */}
        <Card>
          <CardHeader>
            <CardTitle>{t("settings.section.billingDefaults.title")}</CardTitle>
            <CardDescription>
              {t("settings.section.billingDefaults.description")}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="baseCurrency">{t("settings.baseCurrency.label")}</Label>
                <Select value={baseCurrency} onValueChange={setBaseCurrency} disabled={settings.baseCurrencyLocked}><SelectTrigger id="baseCurrency"><SelectValue /></SelectTrigger><SelectContent>{CURRENCIES.map(c => <SelectItem key={c.value} value={c.value}>{c.value}</SelectItem>)}</SelectContent></Select>
                <p className="text-sm text-muted-foreground">{t("settings.baseCurrency.hint")}</p>
                <Label htmlFor="defaultCurrency">{t("settings.currency.label")}</Label>
                <Select value={defaultCurrency} onValueChange={setDefaultCurrency}>
                  <SelectTrigger id="defaultCurrency">
                    <SelectValue placeholder={t("settings.currency.placeholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map((c) => (
                      <SelectItem key={c.value} value={c.value}>
                        {`${c.value} - ${currencyDisplayNames.of(c.value) ?? c.label}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="taxRate">{t("settings.taxRate.label")}</Label>
                <Input
                  id="taxRate"
                  name="taxRate"
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  placeholder="0.00"
                  defaultValue={settings.taxRate ?? ""}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Invoice & Quote Numbering */}
        <Card>
          <CardHeader>
            <CardTitle>{t("settings.section.numbering.title")}</CardTitle>
            <CardDescription>
              {t("settings.section.numbering.description")}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="invoicePrefix">{t("settings.invoicePrefix.label")}</Label>
                <Input
                  id="invoicePrefix"
                  name="invoicePrefix"
                  maxLength={10}
                  pattern="^[A-Z0-9-]{1,10}$"
                  title={t("settings.prefix.title")}
                  placeholder="INV"
                  defaultValue={settings.invoicePrefix}
                />
              </div>
              <div className="grid gap-2">
                <Label>{t("settings.nextInvoiceNumber.label")}</Label>
                <div className="flex h-9 items-center rounded-md border bg-muted px-3 text-sm text-muted-foreground">
                  {settings.invoicePrefix}-{String(settings.invoiceNextNum).padStart(4, "0")}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="quotePrefix">{t("settings.quotePrefix.label")}</Label>
                <Input
                  id="quotePrefix"
                  name="quotePrefix"
                  maxLength={10}
                  pattern="^[A-Z0-9-]{1,10}$"
                  title={t("settings.prefix.title")}
                  placeholder="QTE"
                  defaultValue={settings.quotePrefix}
                />
              </div>
              <div className="grid gap-2">
                <Label>{t("settings.nextQuoteNumber.label")}</Label>
                <div className="flex h-9 items-center rounded-md border bg-muted px-3 text-sm text-muted-foreground">
                  {settings.quotePrefix}-{String(settings.quoteNextNum).padStart(4, "0")}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="creditNotePrefix">{t("creditNotes.settings.prefix.label")}</Label>
                <Input
                  id="creditNotePrefix"
                  name="creditNotePrefix"
                  maxLength={10}
                  pattern="^[A-Z0-9-]{1,10}$"
                  title={t("creditNotes.validation.invalidPrefix")}
                  placeholder="CN"
                  defaultValue={settings.creditNotePrefix}
                />
              </div>
              <div className="grid gap-2">
                <Label>{t("creditNotes.settings.nextNumber.label")}</Label>
                <div className="flex h-9 items-center rounded-md border bg-muted px-3 text-sm text-muted-foreground">
                  {settings.creditNotePrefix}-{String(settings.creditNoteNextNum).padStart(4, "0")}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <EmailDeliveryCard emailDelivery={settings.emailDelivery} />

        {settings.documentSending.managed ? (
          <DocumentEmailSendingCard
            documentSending={settings.documentSending}
            requestedDomain={documentSendingDomainInput}
            busy={documentSendingBusy}
            error={documentSendingError}
            success={documentSendingSuccess}
            onRequestedDomainChange={setDocumentSendingDomainInput}
            onConfigure={handleConfigureDocumentSendingDomain}
            onRefresh={handleRefreshDocumentSendingDomain}
            onDisable={handleDisableDocumentSendingDomain}
          />
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>{t("settings.section.payments.title")}</CardTitle>
            <CardDescription>
              {t("settings.section.payments.description")}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="stripePublishableKey">{t("settings.payments.stripePublishableKey.label")}</Label>
              <Input
                id="stripePublishableKey"
                name="stripePublishableKey"
                autoComplete="off"
                placeholder="pk_test_..."
                defaultValue={settings.stripePublishableKey ?? ""}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="stripeSecretKey">{t("settings.payments.stripeSecretKey.label")}</Label>
              <Input
                id="stripeSecretKey"
                name="stripeSecretKey"
                type="password"
                autoComplete="off"
                placeholder="sk_test_..."
                onChange={() => setClearStripeSecretKey(false)}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="stripeWebhookSecret">{t("settings.payments.stripeWebhookSecret.label")}</Label>
              <Input
                id="stripeWebhookSecret"
                name="stripeWebhookSecret"
                type="password"
                autoComplete="off"
                placeholder="whsec_..."
                onChange={() => setClearStripeWebhookSecret(false)}
              />
              <p className="text-xs text-muted-foreground">
                {settings.stripeByokConfigured
                  ? t("settings.payments.configuredHelp")
                  : t("settings.payments.notConfiguredHelp")}
              </p>
            </div>

            {settings.stripeByokConfigured && (
              <div className="flex flex-wrap items-center gap-2">
                {!clearStripeSecretKey ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setClearStripeSecretKey(true)}
                  >
                    {t("settings.payments.removeSecret")}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setClearStripeSecretKey(false)}
                  >
                    {t("settings.payments.undo")}
                  </Button>
                )}

                {!clearStripeWebhookSecret ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setClearStripeWebhookSecret(true)}
                  >
                    {t("settings.payments.removeWebhook")}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setClearStripeWebhookSecret(false)}
                  >
                    {t("settings.payments.undo")}
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* AI BYOK */}
        <Card>
          <CardHeader>
            <CardTitle>{t("settings.section.ai.title")}</CardTitle>
            <CardDescription>
              {t("settings.section.ai.description")}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="aiOpenRouterModel">{t("settings.aiModel.label")}</Label>
              <Select value={aiOpenRouterModel} onValueChange={setAiOpenRouterModel}>
                <SelectTrigger id="aiOpenRouterModel">
                  <SelectValue placeholder="openai/gpt-4o-mini" />
                </SelectTrigger>
                <SelectContent>
                  {Array.from(new Set([aiOpenRouterModel, ...openRouterModels])).map((model) => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={loadOpenRouterModels}
                  disabled={loadingOpenRouterModels}
                >
                  {loadingOpenRouterModels
                    ? t("settings.aiModel.refreshing")
                    : t("settings.aiModel.refresh")}
                </Button>
              </div>
              {openRouterModelsError && (
                <p className="text-xs text-destructive">{openRouterModelsError}</p>
              )}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="aiOpenRouterApiKey">{t("settings.aiApiKey.label")}</Label>
              <Input
                id="aiOpenRouterApiKey"
                name="aiOpenRouterApiKey"
                type="password"
                autoComplete="off"
                placeholder="sk-or-v1-..."
                onChange={() => setClearAiOpenRouterApiKey(false)}
              />
              <p className="text-xs text-muted-foreground">
                {settings.aiByokConfigured
                  ? t("settings.aiApiKey.configuredHelp")
                  : t("settings.aiApiKey.notConfiguredHelp")}
              </p>
            </div>

            {settings.aiByokConfigured && (
              <div className="flex flex-wrap items-center gap-2">
                {!clearAiOpenRouterApiKey ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setClearAiOpenRouterApiKey(true)}
                  >
                    {t("settings.aiApiKey.remove")}
                  </Button>
                ) : (
                  <>
                    <p className="text-sm text-muted-foreground">
                      {t("settings.aiApiKey.removePending")}
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setClearAiOpenRouterApiKey(false)}
                    >
                      {t("settings.aiApiKey.undo")}
                    </Button>
                  </>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Save */}
        <div className="flex justify-end">
          <Button type="submit" disabled={saving}>
            {saving ? t("settings.action.saving") : t("settings.action.save")}
          </Button>
        </div>
      </form>

      {/* Team Members — outside the settings form */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{t("settings.section.team.title")}</CardTitle>
          <CardDescription>
            {t("settings.section.team.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          {/* Invite form */}
          <form onSubmit={handleInvite} className="flex flex-col sm:flex-row gap-2">
            <Input
              type="email"
              placeholder={t("settings.team.inviteEmail.placeholder")}
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              required
              className="flex-1"
            />
            <Select value={inviteRole} onValueChange={setInviteRole}>
              <SelectTrigger className="w-full sm:w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">{t("settings.role.admin")}</SelectItem>
                <SelectItem value="member">{t("settings.role.member")}</SelectItem>
                <SelectItem value="accountant">{t("settings.role.accountant")}</SelectItem>
              </SelectContent>
            </Select>
            <Button type="submit" disabled={inviting} className="gap-1">
              <UserPlus className="size-4" />
              {inviting ? t("settings.team.action.sending") : t("settings.team.action.invite")}
            </Button>
          </form>
          {inviteError && (
            <p className="text-sm text-destructive">{inviteError}</p>
          )}

          {/* Members list */}
          {teamLoading ? (
            <p className="text-sm text-muted-foreground">{t("settings.team.loading")}</p>
          ) : (
            <div className="divide-y rounded-md border">
              {members.map((m) => {
                const isSelf = m.user.id === session?.user.id
                return (
                  <div
                    key={m.id}
                    className="flex items-center justify-between gap-4 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {m.user.name}
                        {isSelf && (
                          <span className="ml-1 text-muted-foreground">{t("settings.team.you")}</span>
                        )}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {m.user.email}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <RoleBadge
                        role={m.role}
                        label={
                          m.role === "admin"
                            ? t("settings.role.admin")
                            : m.role === "accountant"
                              ? t("settings.role.accountant")
                              : t("settings.role.member")
                        }
                      />
                      {!isSelf && (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive">
                              <X className="size-3.5" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>
                                {t("settings.team.remove.title")}
                              </AlertDialogTitle>
                              <AlertDialogDescription>
                                {t("settings.team.remove.description", {
                                  name: m.user.name,
                                })}
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>{t("settings.team.action.cancel")}</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => handleRemoveMember(m.id)}
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              >
                                {t("settings.team.action.remove")}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </div>
                  </div>
                )
              })}

              {/* Pending invitations */}
              {invitations.map((inv) => (
                <div
                  key={inv.id}
                  className="flex items-center justify-between gap-4 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-muted-foreground">
                      {inv.email}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("settings.team.invitation.pending")}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <RoleBadge
                      role={inv.role}
                      label={
                        inv.role === "admin"
                          ? t("settings.role.admin")
                          : inv.role === "accountant"
                            ? t("settings.role.accountant")
                            : t("settings.role.member")
                      }
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-muted-foreground hover:text-destructive"
                      onClick={() => handleCancelInvite(inv.id)}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-6">
        <ReminderPolicyCard />
        <AgentKeysCard />
        <AuditLogCard />
      </div>
    </div>
  )
}
