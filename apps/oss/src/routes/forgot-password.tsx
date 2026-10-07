import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'
import { authClient } from '../lib/auth-client'
import { useI18n } from '../lib/i18n/react'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'

export const Route = createFileRoute('/forgot-password')({ component: ForgotPasswordPage })

function ForgotPasswordPage() {
  const { t } = useI18n()
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (loading) return
    setError(null)
    setLoading(true)
    try {
      const result = await authClient.requestPasswordReset({
        email: email.trim(),
        redirectTo: `${window.location.origin}/reset-password`,
      })
      if (result.error) {
        setError(t(result.error.status === 429 ? 'auth.recovery.rateLimited' : 'auth.forgotPassword.error'))
      } else {
        setSent(true)
      }
    } catch {
      setError(t('auth.forgotPassword.error'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">{t('auth.forgotPassword.title')}</CardTitle>
          <CardDescription>{t('auth.forgotPassword.description')}</CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="flex flex-col gap-4 pb-6">
            {sent ? <p className="text-sm text-muted-foreground" role="status">{t('auth.forgotPassword.confirmation')}</p> : (
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
            <Link to="/login" className="text-sm text-primary underline underline-offset-4">{t('auth.recovery.backToLogin')}</Link>
          </CardFooter>
        </form>
      </Card>
    </div>
  )
}
