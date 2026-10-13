import { authFieldError } from '../lib/auth/form-validation'
import { AuthPage } from '../components/auth/auth-page'
import { authSearchSchema, authLinkSearch, authDestination } from '../lib/auth/navigation'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { authClient } from '../lib/auth-client'
import { useI18n } from '../lib/i18n/react'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'

export const Route = createFileRoute('/forgot-password')({ validateSearch: authSearchSchema, component: ForgotPasswordPage })

function ForgotPasswordPage() {
  return <AuthPage path="/forgot-password" search={Route.useSearch()}><ForgotPasswordPageContent /></AuthPage>
}

function ForgotPasswordPageContent() {
  const { t, locale } = useI18n()
  const search = authLinkSearch(Route.useSearch(), locale)
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (loading) return
    const fieldError = authFieldError({ email })
    if (fieldError) { setError(t(fieldError)); return }
    setError(null)
    setLoading(true)
    try {
      const result = await authClient.requestPasswordReset({
        email: email.trim(),
        redirectTo: `${window.location.origin}${authDestination('/reset-password', search.lang)}${search.redirect ? `&redirect=${encodeURIComponent(search.redirect)}` : ''}`,
      })
      if (result.error) {
        setError(t(result.error.status === 429 ? 'auth.error.rateLimited' : 'auth.forgotPassword.error'))
      } else {
        setSent(true)
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
          <CardTitle className="text-2xl">{t(sent ? 'auth.forgotPassword.confirmationTitle' : 'auth.forgotPassword.title')}</CardTitle>
          {!sent && <CardDescription>{t('auth.forgotPassword.description')}</CardDescription>}
        </CardHeader>
        <form onSubmit={handleSubmit} noValidate>
          <CardContent className="flex flex-col gap-4 pb-6">
            {sent ? <p className="text-sm text-muted-foreground" role="status">{t('auth.forgotPassword.confirmation', { email: email.trim() })}</p> : (
              <>
                {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
                <div className="flex flex-col gap-2">
                  <Label htmlFor="email">{t('auth.email')}</Label>
                  <Input id="email" type="email" autoComplete="email" required disabled={loading}
                    placeholder={t('auth.placeholder.email')} value={email} onChange={(event) => setEmail(event.target.value)} />
                </div>
              </>
            )}
          </CardContent>
          <CardFooter className="flex flex-col gap-4">
            {!sent ? <Button type="submit" className="w-full" disabled={loading}>
              {t(loading ? 'auth.forgotPassword.submitting' : 'auth.forgotPassword.submit')}
            </Button> : null}
            <Link to="/login" search={search} className="text-sm text-brand-text underline underline-offset-4">{t('auth.recovery.backToLogin')}</Link>
          </CardFooter>
        </form>
      </Card>
    </>
  )
}
