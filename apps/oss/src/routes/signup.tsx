import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { getSignupConfiguration } from '../lib/runtime/signup-config'
import { InviteCodeField } from '../components/auth/invite-code-field'
import { QuitsWordmark } from '../components/brand/quits-wordmark'
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
  validateSearch: z.object({ invite: z.string().max(64).optional() }),
  loader: () => getSignupConfiguration(),
  component: SignupPage,
})

export function SignupPage() {
  return <SignupForm configuration={Route.useLoaderData()} invite={Route.useSearch().invite} />
}

export function SignupForm({ configuration: { signupMode, waitlist }, invite }: {
  configuration: { signupMode: 'open' | 'invite_only'; waitlist?: { privacyVersion: string; privacyPath: string } }
  invite?: string
}) {
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
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (pending.current) return
    pending.current = true
    setError(null)
    setInviteInvalid(false)
    setLoading(true)
    try {
      const result = await authClient.signUp.email(
        { email, password, name },
        inviteOnly ? { body: { inviteCode: inviteCode.replace(/\s/g, '').toUpperCase() } } : {},
      )
      if (result.error) {
        if (result.error.code === 'invite_invalid') { setInviteInvalid(true); codeRef.current?.focus() }
        else if (result.error.code === 'not_invited') setView('blocked')
        else setError(result.error.code === 'rate_limited' || result.error.status === 429 ? t('auth.signup.error.rateLimited') : result.error.message ?? t('auth.signup.error'))
      }
      if (result.data) loadPage('/onboarding')
    } catch { setError(t('auth.signup.error')) }
    finally { pending.current = false; setLoading(false) }
  }

  if (view === 'blocked') return <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-4 py-8">
    <QuitsWordmark style={{ fontSize: 26 }} />
    <InviteOnlyPanel email={email} waitlist={waitlist} onUseCode={() => { focusCode.current = true; setView('form') }}
      onJoined={(value) => { setJoinedEmail(value); setView('joined') }} />
  </div>
  if (view === 'joined') return <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-4 py-8">
    <QuitsWordmark style={{ fontSize: 26 }} />
    <Card className="w-full max-w-sm">
      <CardHeader>
        <h1 ref={titleRef} tabIndex={-1} className="text-2xl font-semibold">{t('auth.waitlist.successTitle')}<span className="text-tone-success" aria-hidden="true">▪</span></h1>
        <CardDescription>{t('auth.waitlist.successBody')}</CardDescription>
        <p className="text-sm text-muted-foreground">{t('auth.waitlist.successFor')}{' '}<span className="font-mono text-foreground">{joinedEmail}</span></p>
      </CardHeader>
      <CardContent><Button variant="outline" className="w-full" asChild><Link to="/login">{t('auth.inviteOnly.backToLogin')}</Link></Button></CardContent>
    </Card>
  </div>

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-4 py-8">
      <QuitsWordmark style={{ fontSize: 26 }} />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">{t('auth.signup.title')}</CardTitle>
          <CardDescription>
            {t(inviteOnly ? 'auth.signup.inviteOnly.description' : 'auth.signup.description')}
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
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
                autoComplete="new-password"
              />
            </div>
            {inviteOnly && <InviteCodeField value={inviteCode} onChange={(value) => { setInviteCode(value); setInviteInvalid(false) }}
              fromLink={Boolean(invite)} invalid={inviteInvalid} inputRef={codeRef} />}
          </CardContent>
          <CardFooter className="flex flex-col gap-4">
            <Button type="submit" className={inviteOnly ? "w-full bg-foreground text-background hover:bg-foreground/90" : "w-full"} disabled={loading}>
              {loading ? t('auth.signup.submitting') : t('auth.signup.submit')}
            </Button>
            <p className="text-sm text-muted-foreground">
              {t('auth.signup.hasAccount')}{' '}
              <Link to="/login" className="text-brand-text underline">
                {t('auth.signup.toLogin')}
              </Link>
            </p>
          </CardFooter>
        </form>
      </Card>
    </div>
  )
}
