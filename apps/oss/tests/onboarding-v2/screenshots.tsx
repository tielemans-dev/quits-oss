import { createRoot } from "react-dom/client"
import { useState } from "react"
import { I18nProvider } from "../../src/lib/i18n/react"
import { OnboardingV2 } from "../../src/components/onboarding-v2/onboarding-v2"
import { FirstRun } from "../../src/components/dashboard/welcome"
import { useFirstInvoiceBankNudge } from "../../src/components/onboarding-v2/bank-nudge"
import { Route as BaselineRoute } from "qui56-baseline-onboarding"
import { FirstRun as BaselineFirstRun } from "qui56-baseline-welcome"
import type { OnboardingV2Client } from "../../src/components/onboarding-v2/client"
import type { CvrCompany } from "@quits/contracts/cvr"
import "./fixture.css"

const params = new URLSearchParams(location.search)
const state = params.get("state") ?? "search"
document.documentElement.classList.toggle("dark", params.get("theme") === "dark")
document.documentElement.lang = params.get("locale") === "en-GB" ? "en" : "da"
const english = params.get("locale") === "en-GB"
const company: CvrCompany = {
  cvr: "24256790",
  name: "Nordlys Studio ApS",
  address: "Nørrebrogade 12, 2. tv.\n2200 København N",
  companyForm: "ApS",
  industry: "Designarbejde",
  status: state === "ceased" ? "ceased" : state === "warning" ? "liquidation" : "active",
  statusClass: state === "ceased" ? "blocked" : state === "warning" ? "warn" : "active",
  statusDate: "2026-10-01",
  momsRegistered: state !== "no-vat",
}
function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(new DOMException("Aborted", "AbortError"))
      },
      { once: true },
    )
  })
}
const client: OnboardingV2Client = {
  search: async (q) =>
    q === "00000000"
      ? []
      : state === "several"
        ? [
            company,
            {
              ...company,
              cvr: "10150817",
              name: "Nordlys Handel",
              status: "ceased",
              statusClass: "blocked",
            },
          ]
        : [company],
  get: async (_, signal) => {
    await wait(["working", "timeout"].includes(state) ? 30_000 : 100, signal)
    if (state === "lookup-fail") throw new Error("Lookup unavailable")
    return company
  },
  suggestions: async (_, signal) => {
    await wait(state === "suggestions-loading" ? 30_000 : 200, signal)
    if (state === "agent-fail") throw new Error("Suggestion provider unavailable")
    return {
      customers: [
        {
          id: "customer",
          label: english ? "Small and medium-sized businesses" : "Små og mellemstore virksomheder",
        },
      ],
      lines: [
        {
          id: "line",
          description: english ? "Design work" : "Designarbejde",
          unitPrice: 850,
          unit: "hour",
        },
      ],
    }
  },
  confirm: async () => {
    if (state === "confirming") await wait(30_000)
    if (state === "save-failed") throw new Error("Save unavailable")
    return { status: "complete" }
  },
}
function Nudge() {
  const nudge = useFirstInvoiceBankNudge()
  return (
    <main className="p-8">
      <button onClick={() => void nudge.beforeSend()}>
        {english ? "Send invoice" : "Send faktura"}
      </button>
      {nudge.dialog}
    </main>
  )
}
function Screens() {
  const [done, setDone] = useState(false)
  if (state === "baseline") return <BaselineRoute.component />
  if (state === "baseline-dashboard")
    return (
      <main className="p-6">
        <BaselineFirstRun />
      </main>
    )
  if (state === "dashboard" || done)
    return (
      <main className="p-6">
        <FirstRun readyCompany="Nordlys Studio ApS" />
      </main>
    )
  if (state === "bank-nudge") return <Nudge />
  return (
    <OnboardingV2
      userId="screen-user"
      organizationId="screen-org"
      signupEmail="billing@example.com"
      client={client}
      onComplete={() => setDone(true)}
    />
  )
}
createRoot(document.getElementById("root")!).render(
  <I18nProvider locale={params.get("locale") ?? "da-DK"}>
    <Screens />
  </I18nProvider>,
)
