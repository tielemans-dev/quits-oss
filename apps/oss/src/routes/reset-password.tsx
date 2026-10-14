import { AuthPage } from '../components/auth/auth-page'
import { authSearchSchema, authLinkSearch, authDestination } from '../lib/auth/navigation'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { z } from 'zod'
import { authClient } from '../lib/auth-client'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../lib/auth/password-policy'
import { useI18n } from '../lib/i18n/react'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'

export const Route = createFileRoute('/reset-password')({
  validateSearch: authSearchSchema.extend({ token: z.string().optional(), error: z.string().optional() }),
  head: () => ({ meta: [{ name: 'referrer', content: 'no-referrer' }, { name: 'robots', content: 'noindex' }] }),
  component: ResetPasswordPage,
})

function ResetPasswordPage() {
  const search = Route.useSearch()
  const [completed, setCompleted] = useState(false)
  const headerSearch = completed ? { ...search, token: undefined, error: undefined } : search
  return <AuthPage path="/reset-password" search={headerSearch}><ResetPasswordPageContent onSuccess={() => setCompleted(true)} /></AuthPage>
}

function ResetPasswordPageContent({ onSuccess }: { onSuccess: () => void }) {
  const { token, error: tokenError } = Route.useSearch()
  const { t, locale } = useI18n()
  const search = authLinkSearch(Route.useSearch(), locale)
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [loading, setLoading] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const invalidToken = invalid || !token || Boolean(tokenError)
  const policy = t('auth.resetPassword.policy', { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH })

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (loading || invalidToken || success) return
    setError(null)
    if (!password) { setError(t('auth.error.passwordRequired')); return }
    if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
      setError(t(password.length < PASSWORD_MIN_LENGTH ? 'auth.error.passwordTooShort' : 'auth.error.passwordTooLong', { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH }))
      return
    }
    if (password !== confirmation) {
      setError(t('auth.resetPassword.mismatch'))
      return
    }
    setLoading(true)
    try {
      const result = await authClient.resetPassword({ token, newPassword: password })
      if (result.error) {
        if (result.error.code === 'INVALID_TOKEN') setInvalid(true)
        else setError(t(result.error.status === 429 ? 'auth.error.rateLimited' : 'auth.resetPassword.error'))
      } else {
        setPassword('')
        setConfirmation('')
        setSuccess(true)
        onSuccess()
        // Remove the one-time credential from this tab's current address and history entry.
        window.history.replaceState(window.history.state, '', authDestination('/reset-password', search.lang) + (search.redirect ? `&redirect=${encodeURIComponent(search.redirect)}` : ''))
      }
    } catch {
      setError(t('auth.error.network'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">{t('auth.resetPassword.title')}</CardTitle>
          <CardDescription>{t('auth.resetPassword.description')}</CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit} noValidate>
          <CardContent className="flex flex-col gap-4 pb-6">
            {success ? <p className="text-sm text-muted-foreground" role="status">{t('auth.resetPassword.success')}</p> : invalidToken ? (
              <p className="text-sm text-destructive" role="alert">{t('auth.resetPassword.invalid')}</p>
            ) : <>
              {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
              <div className="flex flex-col gap-2">
                <Label htmlFor="new-password">{t('auth.resetPassword.newPassword')}</Label>
                <Input id="new-password" type="password" autoComplete="new-password" required disabled={loading}
                  minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} aria-describedby="password-policy"
                  value={password} onChange={(event) => setPassword(event.target.value)} />
                <p id="password-policy" className="text-sm text-muted-foreground">{policy}</p>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="confirm-password">{t('auth.resetPassword.confirmPassword')}</Label>
                <Input id="confirm-password" type="password" autoComplete="new-password" required disabled={loading}
                  maxLength={PASSWORD_MAX_LENGTH} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
              </div>
            </>}
          </CardContent>
          <CardFooter className="flex flex-col gap-4">
            {!success && !invalidToken ? <Button type="submit" className="w-full" disabled={loading}>
              {t(loading ? 'auth.resetPassword.submitting' : 'auth.resetPassword.submit')}
            </Button> : null}
            {!success && invalidToken ? <Link to="/forgot-password" search={search} className="text-sm text-brand-text underline underline-offset-4">
              {t('auth.resetPassword.requestNew')}
            </Link> : null}
            <Link to="/login" search={search} className="text-sm text-brand-text underline underline-offset-4">{t(success ? 'auth.resetPassword.successCta' : 'auth.recovery.backToLogin')}</Link>
          </CardFooter>
        </form>
      </Card>
    </>
  )
}
