import { authFieldError } from '../lib/auth/form-validation'
import { z } from 'zod'
import { AuthPage } from '../components/auth/auth-page'
import { authLinkSearch } from '../lib/auth/navigation'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { authClient } from '../lib/auth-client'
import { switchActiveOrganization } from '../lib/active-organization'
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
import { invalidateAppLayoutSession } from '../lib/app-layout-session'
import { useRuntimeDistribution } from '../lib/runtime-distribution'
import { getOrganizationAccessState } from '../lib/organization-access'
import { listOrganizationsAfterSignIn } from '../lib/auth/post-login'
import { loginReturnSearchSchema, loginReturnTarget, loginReturnDestination, loginReturnOnboarding } from '../lib/login-return'

const loginSearchSchema = loginReturnSearchSchema.extend({
  message: z.string().optional(),
})

export const Route = createFileRoute('/login')({
  validateSearch: loginSearchSchema,
  component: LoginPage,
})

function LoginPage() {
  return <AuthPage path="/login" search={Route.useSearch()}><LoginPageContent /></AuthPage>
}

function LoginPageContent() {
  const { t, locale } = useI18n()
  const { isCloud } = useRuntimeDistribution()
  const search = Route.useSearch()
  const { message, lang } = search
  const linkSearch = authLinkSearch(search, locale)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // Post-login work outlives a click by up to a few seconds; once the page is left it must not
  // switch organization or load another page on the user's behalf.
  const unmounted = useRef(false)
  useEffect(() => {
    unmounted.current = false
    return () => { unmounted.current = true }
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (loading) return
    const fieldError = authFieldError({ email, password })
    if (fieldError) { setError(t(fieldError)); return }
    setError(null)
    setLoading(true)

    let result
    try {
      result = await authClient.signIn.email(
        { email: email.trim(), password },
        {
          onError: (ctx) => {
            setError(t(ctx.error.status === 429 ? 'auth.error.rateLimited' : 'auth.login.error'))
          },
        },
      )
    } catch {
      setError(t('auth.error.network'))
      setLoading(false)
      return
    }

    if (!result.data) setLoading(false)
    if (result.error) setError(t(result.error.status === 429 ? 'auth.error.rateLimited' : 'auth.login.error'))
    if (result.data) {
      // The next page load must not reuse an answer given before signing in. (Mainly matters for a
      // back/forward-cache restore; see `invalidateAppLayoutSession`.)
      invalidateAppLayoutSession()
      // Every way out of here is a new page load, so the app layout sets the organization this
      // tab acts for from the new session and nothing of an earlier session survives.
      const target = loginReturnTarget(search)
      const redirectPath = loginReturnDestination(target ?? '/', lang)
      try {
        const listed = await listOrganizationsAfterSignIn(() => authClient.organization.list(), undefined, () => unmounted.current)
        if (unmounted.current) return
        if (listed.kind === 'no-session') {
          // The server does not see the session yet: navigating on would only bounce to /login.
          setError(t('auth.login.sessionPending'))
          setLoading(false)
          return
        }
        const accessState = getOrganizationAccessState({
          organizations: listed.kind === 'listed' ? listed.organizations : [],
        })

        if (accessState.kind === 'auto-select') {
          const switched = await switchActiveOrganization(accessState.organizationId, {
            destination: target ? redirectPath : loginReturnDestination(isCloud ? '/onboarding' : '/', lang),
            isCancelled: () => unmounted.current,
          })
          if (!switched?.error || unmounted.current) return
        }

        if (accessState.kind === 'choose' || accessState.kind === 'create') {
          loadPage(loginReturnOnboarding(search))
          return
        }
      } catch {
        // Fall through to the normal post-login route and let app guards recover.
      }

      if (!unmounted.current) loadPage(redirectPath)
    }
  }

  return (
    <>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">{t('auth.login.title')}</CardTitle>
          <CardDescription>
            {t('auth.login.description')}
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit} noValidate>
          <CardContent className="flex flex-col gap-4 pb-4">
            {message && (
              <p className="text-sm text-muted-foreground" role="status">
                {message}
              </p>
            )}
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
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
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="password">{t('auth.password')}</Label>
                <Link to="/forgot-password" search={linkSearch} className="text-sm text-brand-text underline underline-offset-4">
                  {t('auth.login.forgotPassword')}
                </Link>
              </div>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </div>
          </CardContent>
          <CardFooter className="flex flex-col gap-4">
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? t('auth.login.submitting') : t('auth.login.submit')}
            </Button>
            <p className="text-sm text-muted-foreground">
              {t('auth.login.noAccount')}{' '}
              <Link to="/signup" search={linkSearch} className="text-brand-text underline">
                {t('auth.login.toSignup')}
              </Link>
            </p>
          </CardFooter>
        </form>
      </Card>
    </>
  )
}
