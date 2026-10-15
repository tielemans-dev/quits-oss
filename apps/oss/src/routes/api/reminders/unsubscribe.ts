import { createFileRoute } from "@tanstack/react-router"

export const Route = createFileRoute("/api/reminders/unsubscribe")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { unsubscribeResponseHeaders } = await import("../../../lib/reminders/unsubscribe")
        const token = new URL(request.url).searchParams.get("token") ?? ""
        if (token.length > 256) return new Response(null, { status: 400, headers: unsubscribeResponseHeaders })
        return new Response(null, { status: 303, headers: { ...unsubscribeResponseHeaders, Location: `/reminders/unsubscribe?token=${encodeURIComponent(token)}` } })
      },
      POST: async ({ request }) => {
        const { prisma } = await import("../../../lib/db")
        const { postReminderUnsubscribe } = await import("../../../lib/reminders/unsubscribe")
        return postReminderUnsubscribe(request, prisma, true)
      },
    },
  },
})
