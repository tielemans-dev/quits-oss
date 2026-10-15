import { createFileRoute } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { QuitsWordmark } from "../components/brand/quits-wordmark"
import { LocalizedDocument } from "../components/documents/localized-document"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardHeader } from "../components/ui/card"
import { useI18n } from "../lib/i18n/react"
import { translate } from "../lib/i18n/translate"
import { getReminderUnsubscribeSession } from "../lib/reminders/unsubscribe-session"

export const Route = createFileRoute("/reminders/unsubscribe")({
  validateSearch: (search: Record<string, unknown>) => ({ token: typeof search.token === "string" && search.token.length <= 256 ? search.token : "" }),
  loaderDeps: ({ search }) => ({ token: search.token }),
  loader: ({ deps }) => getReminderUnsubscribeSession({ data: deps }),
  head: ({ loaderData }) => ({ meta: [
    { title: `${translate(`email.reminderUnsubscribe.${loaderData?.kind ?? "invalid"}.title`, loaderData?.locale)} · quits.` },
    { name: "robots", content: "noindex, nofollow" },
    { name: "referrer", content: "no-referrer" },
  ] }),
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { prisma } = await import("../lib/db")
        const { postReminderUnsubscribe } = await import("../lib/reminders/unsubscribe")
        return postReminderUnsubscribe(request, prisma, false)
      },
    },
  },
  component: ReminderUnsubscribeRoute,
})

function ReminderUnsubscribeRoute() {
  const state = Route.useLoaderData()
  return <LocalizedDocument locale={state.locale}><ReminderUnsubscribePage /></LocalizedDocument>
}

function ReminderUnsubscribePage() {
  const state = Route.useLoaderData()
  const { token } = Route.useSearch()
  const { t } = useI18n()
  const [submitting, setSubmitting] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (state.kind === "done") heading.current?.focus()
  }, [state.kind])

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-8 bg-background px-4 py-12">
      <QuitsWordmark className="text-[26px]" />
      <Card className="w-full max-w-[400px] shadow-none">
        <CardHeader>
          <h1 ref={heading} tabIndex={state.kind === "done" ? -1 : undefined} className="text-xl font-medium tracking-tight">
            {t(`email.reminderUnsubscribe.${state.kind}.title`)}
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t(`email.reminderUnsubscribe.${state.kind}.body`, { organization: state.kind === "invalid" ? "" : state.organizationName })}
          </p>
        </CardHeader>
        {state.kind === "confirm" && (
          <CardContent>
            <form method="post" action="/reminders/unsubscribe" onSubmit={() => setSubmitting(true)} aria-busy={submitting}>
              <input type="hidden" name="token" value={token} />
              <Button type="submit" disabled={submitting} className="h-10 w-full">
                {t(submitting ? "email.reminderUnsubscribe.submitting" : "email.reminderUnsubscribe.button")}
              </Button>
            </form>
          </CardContent>
        )}
      </Card>
    </main>
  )
}
