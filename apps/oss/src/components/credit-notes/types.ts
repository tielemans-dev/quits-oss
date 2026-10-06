import type { inferRouterOutputs } from "@trpc/server"
import type { AppRouter } from "../../trpc/router"

type CreditNotesOutputs = inferRouterOutputs<AppRouter>["creditNotes"]

export type CreditNoteListItem = CreditNotesOutputs["list"][number]
export type CreditNoteDetail = CreditNotesOutputs["get"]
export type CreditNoteAvailability = CreditNotesOutputs["availability"]
