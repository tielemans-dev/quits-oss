import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { authClient } from '../lib/auth-client'
import { setRequestOrganizationId, switchActiveOrganization } from '../lib/active-organization'
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
import { z } from 'zod'
import { useI18n } from '../lib/i18n/react'
import { isCloudDistribution } from '../lib/distribution'
import { getOrganizationAccessState } from '../lib/organization-access'
import { toInternalRedirectPath } from '../lib/redirect-target'

const loginSearchSchema = z.object({
  redirect: z.string().optional(),
  message: z.string().optional(),
})

export const Route = createFileRoute('/login')({
  validateSearch: loginSearchSchema,
  component: LoginPage,
})

function LoginPage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const { redirect, message } = Route.useSearch()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)

    const result = await authClient.signIn.email(
      { email, password },
      {
        onError: (ctx) => {
          setError(ctx.error.message ?? t('auth.login.error'))
        },
      },
    )

    setLoading(false)

    if (result.data) {
      // A new session: forget the organization an earlier session of this tab acted for.
      setRequestOrganizationId(null)
      try {
        const organizations = await authClient.organization.list()
        const accessState = getOrganizationAccessState({
          organizations: organizations.data ?? [],
        })

        if (accessState.kind === 'auto-select') {
          await switchActiveOrganization(accessState.organizationId)

          if (isCloudDistribution) {
            navigate({ to: '/onboarding' })
            return
          }
        }

        if (accessState.kind === 'choose' || accessState.kind === 'create') {
          navigate({ to: '/onboarding' })
          return
        }
      } catch {
        // Fall through to the normal post-login route and let app guards recover.
      }

      const redirectPath = toInternalRedirectPath(redirect)
      if (redirectPath) {
        navigate({ href: redirectPath })
      } else {
        navigate({ to: '/' })
      }
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">{t('auth.login.title')}</CardTitle>
          <CardDescription>
            {t('auth.login.description')}
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="flex flex-col gap-4">
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
              <Label htmlFor="password">{t('auth.password')}</Label>
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
              <Link to="/signup" className="text-primary underline">
                {t('auth.login.toSignup')}
              </Link>
            </p>
          </CardFooter>
        </form>
      </Card>
    </div>
  )
}
