import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { authClient } from '../lib/auth-client'
import { switchActiveOrganization } from '../lib/active-organization'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card'
import { Button } from '../components/ui/button'
import { useI18n } from '../lib/i18n/react'

export const Route = createFileRoute('/accept-invitation/$invitationId')({
  component: AcceptInvitationPage,
})

function AcceptInvitationPage() {
  const { t } = useI18n()
  const { invitationId } = Route.useParams()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function accept() {
      const result = await authClient.organization.acceptInvitation({
        invitationId,
      })

      if (cancelled) return

      if (result.error) {
        // Not logged in — redirect to login with a redirect-back param
        if (
          result.error.status === 401 ||
          result.error.code === 'UNAUTHORIZED'
        ) {
          navigate({
            to: '/login',
            search: {
              redirect: `/accept-invitation/${invitationId}`,
            },
          })
          return
        }

        setError(
          result.error.message ??
            t("acceptInvitation.error.fallback")
        )
        return
      }

      if (result.data) {
        // Loads a new page acting for the organization joined. If this page was left meanwhile,
        // the session switched anyway and other pages of this tab are asked to reload.
        const switched = await switchActiveOrganization(result.data.invitation.organizationId, {
          isCancelled: () => cancelled,
        })
        if (switched?.error && !cancelled) {
          setError(switched.error.message ?? t("acceptInvitation.error.fallback"))
        }
      }
    }

    accept()

    return () => {
      cancelled = true
    }
  }, [invitationId, navigate, t])

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="text-2xl">
              {t("acceptInvitation.error.title")}
            </CardTitle>
            <CardDescription>
              {t("acceptInvitation.error.description")}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
            <Button variant="outline" onClick={() => navigate({ to: '/' })}>
              {t("acceptInvitation.error.goHome")}
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">
            {t("acceptInvitation.pending.title")}
          </CardTitle>
          <CardDescription>
            {t("acceptInvitation.pending.description")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {t("acceptInvitation.pending.body")}
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
