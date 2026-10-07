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
  validateSearch: z.object({ token: z.string().optional(), error: z.string().optional() }),
  head: () => ({ meta: [{ name: 'referrer', content: 'no-referrer' }, { name: 'robots', content: 'noindex' }] }),
  component: ResetPasswordPage,
})

function ResetPasswordPage() {
  const { token, error: tokenError } = Route.useSearch()
  const { t } = useI18n()
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
    if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
      setError(policy)
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
        else setError(t(result.error.status === 429 ? 'auth.recovery.rateLimited' : 'auth.resetPassword.error'))
      } else {
        setPassword('')
        setConfirmation('')
        setSuccess(true)
        // Remove the one-time credential from this tab's current address and history entry.
        window.history.replaceState(window.history.state, '', '/reset-password')
      }
    } catch {
      setError(t('auth.resetPassword.error'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">{t('auth.resetPassword.title')}</CardTitle>
          <CardDescription>{t('auth.resetPassword.description')}</CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
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
            {!success && invalidToken ? <Link to="/forgot-password" className="text-sm text-primary underline underline-offset-4">
              {t('auth.resetPassword.requestNew')}
            </Link> : null}
            <Link to="/login" className="text-sm text-primary underline underline-offset-4">{t('auth.recovery.backToLogin')}</Link>
          </CardFooter>
        </form>
      </Card>
    </div>
  )
}
