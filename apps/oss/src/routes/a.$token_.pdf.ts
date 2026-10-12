import { localeFromAcceptLanguage } from "../lib/i18n/accept-language"
import { createFileRoute } from "@tanstack/react-router"
export const Route = createFileRoute("/a/$token_/pdf")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const { publicAgreementPdf } = await import("../lib/agreements/pdf-access")
        return publicAgreementPdf(params.token, localeFromAcceptLanguage(request.headers.get("accept-language")))
      },
    },
  },
})
