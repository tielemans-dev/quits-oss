import { authFieldError } from '../lib/auth/form-validation'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { getSignupConfiguration } from '../lib/runtime/signup-config'
import { InviteCodeField } from '../components/auth/invite-code-field'
import { AuthPage } from '../components/auth/auth-page'
import { authSearchSchema, authLinkSearch, authDestination, type AuthSearch } from '../lib/auth/navigation'
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from '../lib/auth/password-policy'
import { InviteOnlyPanel } from '../components/auth/invite-only-panel'
import { authClient } from '../lib/auth-client'
import { loadPage } from '../lib/page-navigation'
import { Button } from '../components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { useI18n } from '../lib/i18n/react'

export const Route = createFileRoute('/signup')({
  validateSearch: authSearchSchema.extend({ invite: z.string().max(64).optional() }),
  loader: () => getSignupConfiguration(),
  component: SignupPage,
})

export function SignupPage() {
  return <SignupForm configuration={Route.useLoaderData()} invite={Route.useSearch().invite} search={Route.useSearch()} />
}

type SignupFormProps = {
  configuration: { signupMode: 'open' | 'invite_only'; waitlist?: { privacyVersion: string; privacyPath: string } }
  invite?: string
  search?: AuthSearch
}

export function SignupForm(props: SignupFormProps) {
  return <AuthPage search={props.search}><SignupFormContent {...props} /></AuthPage>
}

function SignupFormContent({ configuration: { signupMode, waitlist }, invite, search: suppliedSearch = {} }: SignupFormProps) {
  const inviteOnly = signupMode === 'invite_only'
  const [inviteCode, setInviteCode] = useState(invite ?? '')
  const [view, setView] = useState<'form' | 'blocked' | 'joined'>('form')
  const [inviteInvalid, setInviteInvalid] = useState(false)
  const [joinedEmail, setJoinedEmail] = useState('')
  const codeRef = useRef<HTMLInputElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const focusCode = useRef(false)
  const pending = useRef(false)
  useEffect(() => {
    if (view === 'joined') titleRef.current?.focus()
    if (view === 'form' && focusCode.current) { codeRef.current?.focus(); focusCode.current = false }
  }, [view])
  const { t, locale } = useI18n()
  const search = authLinkSearch(suppliedSearch, locale)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (pending.current) return
    const fieldError = authFieldError({ email, password, name })
    if (fieldError) { setError(t(fieldError)); return }
    if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
      setError(t(password.length < PASSWORD_MIN_LENGTH ? 'auth.error.passwordTooShort' : 'auth.error.passwordTooLong', { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH }))
      return
    }
    pending.current = true
    setError(null)
    setInviteInvalid(false)
    setLoading(true)
    try {
      const result = await authClient.signUp.email(
        { email: email.trim(), password, name: name.trim() },
        inviteOnly ? { body: { inviteCode: inviteCode.replace(/\s/g, '').toUpperCase() } } : {},
      )
      if (result.error) {
        if (result.error.code === 'invite_invalid') { setInviteInvalid(true); codeRef.current?.focus() }
        else if (result.error.code === 'not_invited') setView('blocked')
        else setError(t(result.error.code === 'rate_limited' || result.error.status === 429 ? 'auth.error.rateLimited' : 'auth.signup.error'))
      }
      // An inferred auth language must not pin onboarding's browser/organization default.
      if (result.data) loadPage(authDestination('/onboarding', suppliedSearch.lang))
    } catch { setError(t('auth.error.network')) }
    finally { pending.current = false; setLoading(false) }
  }

  if (view === 'blocked') return <>
    <InviteOnlyPanel search={search} email={email} waitlist={waitlist} onUseCode={() => { focusCode.current = true; setView('form') }}
      onJoined={(value) => { setJoinedEmail(value); setView('joined') }} />
  </>
  if (view === 'joined') return <>
    <Card className="w-full max-w-sm">
      <CardHeader>
        <h1 ref={titleRef} tabIndex={-1} className="text-2xl font-semibold">{t('auth.waitlist.successTitle')}<span className="text-tone-success" aria-hidden="true">▪</span></h1>
        <CardDescription>{t('auth.waitlist.successBody')}</CardDescription>
        <p className="text-sm text-muted-foreground">{t('auth.waitlist.successFor')}{' '}<span className="font-mono text-foreground">{joinedEmail}</span></p>
      </CardHeader>
      <CardContent><Button variant="outline" className="w-full" asChild><Link to="/login" search={search}>{t('auth.inviteOnly.backToLogin')}</Link></Button></CardContent>
    </Card>
  </>

  return (
    <>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">{t('auth.signup.title')}</CardTitle>
          <CardDescription>
            {t(inviteOnly ? 'auth.signup.inviteOnly.description' : 'auth.signup.description')}
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit} noValidate>
          <CardContent className="flex flex-col gap-4 pb-4">
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">{t('auth.signup.name')}</Label>
              <Input
                id="name"
                type="text"
                placeholder={t('auth.signup.placeholder.name')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoComplete="name"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">{t('auth.email')}</Label>
              <Input
                id="email"
                type="email"
                placeholder={t('auth.placeholder.email')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">{t('auth.password')}</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH}
                aria-describedby="password-help" autoComplete="new-password"
              />
            </div>
            <p id="password-help" className="text-sm text-muted-foreground">{t('auth.signup.passwordHelp', { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH })}</p>
            {inviteOnly && <InviteCodeField value={inviteCode} onChange={(value) => { setInviteCode(value); setInviteInvalid(false) }}
              fromLink={Boolean(invite)} invalid={inviteInvalid} inputRef={codeRef} />}
          </CardContent>
          <CardFooter className="flex flex-col gap-4">
            <Button type="submit" className={inviteOnly ? "w-full bg-foreground text-background hover:bg-foreground/90" : "w-full"} disabled={loading}>
              {loading ? t('auth.signup.submitting') : t('auth.signup.submit')}
            </Button>
            <p className="text-sm text-muted-foreground">
              {t('auth.signup.hasAccount')}{' '}
              <Link to="/login" search={search} className="text-brand-text underline">
                {t('auth.signup.toLogin')}
              </Link>
            </p>
          </CardFooter>
        </form>
      </Card>
    </>
  )
}
