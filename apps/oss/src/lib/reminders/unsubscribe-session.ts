import { createServerFn } from "@tanstack/react-start"
import { getRequestHeader, setResponseHeader, setResponseStatus } from "@tanstack/react-start/server"
import { z } from "zod"

export const getReminderUnsubscribeSession = createServerFn({ method: "GET" })
  .inputValidator(z.object({ token: z.string().max(256) }))
  .handler(async ({ data }) => {
    const { prisma } = await import("../db")
    const { readReminderUnsubscribeState, unsubscribeResponseHeaders } = await import("./unsubscribe")
    for (const [name, value] of Object.entries(unsubscribeResponseHeaders)) setResponseHeader(name, value)
    const state = await readReminderUnsubscribeState(prisma, data.token, getRequestHeader("accept-language"))
    if (state.kind === "invalid") setResponseStatus(400)
    return state
  })
