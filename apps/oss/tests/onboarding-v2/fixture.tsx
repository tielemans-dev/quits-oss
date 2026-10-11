import { createRoot } from "react-dom/client"
import { useState } from "react"
import { I18nProvider } from "../../src/lib/i18n/react"
import { OnboardingV2 } from "../../src/components/onboarding-v2/onboarding-v2"
import type { OnboardingV2Client } from "../../src/components/onboarding-v2/client"
import type { CvrCompany } from "@quits/contracts/cvr"
import "./fixture.css"

const params = new URLSearchParams(location.search)
const scenario = params.get("scenario")
const company: CvrCompany = {
  cvr: "24256790",
  name: "Nordlys Studio ApS",
  address: "Nørrebrogade 12, 2. tv.\n2200 København N",
  companyForm: "ApS",
  industry: "Designarbejde",
  status: scenario === "ceased" ? "ceased" : scenario === "warning" ? "liquidation" : "active",
  statusClass: scenario === "ceased" ? "blocked" : scenario === "warning" ? "warn" : "active",
  statusDate: "2026-10-01",
  momsRegistered: scenario !== "no-vat",
}
const client: OnboardingV2Client = {
  search: async (query, signal) => {
    await wait(50, signal)
    return query === "00000000" || query === "Unknown"
      ? []
      : scenario === "several"
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
        : [company]
  },
  get: async (_, signal) => {
    await wait(scenario === "timeout" ? 30_000 : 150, signal)
    if (scenario === "lookup-fail") throw new Error("Lookup unavailable")
    return company
  },
  suggestions: async (_, signal) => {
    await wait(scenario === "slow" ? 6000 : 300, signal)
    if (scenario === "agent-fail") throw new Error("Suggestions unavailable")
    return {
      customers: [{ id: "customer", label: "Små og mellemstore virksomheder" }],
      lines: [{ id: "line", description: "Designarbejde", unitPrice: 850, unit: "hour" }],
    }
  },
  confirm: async (input) => {
    // Browser tests inspect actual transport requests and retry identities, not component internals.
    const response = await fetch("/confirm", {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "content-type": "application/json" },
    })
    if (!response.ok) throw new Error("Save unavailable")
    return response.json()
  },
}
function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, ms)
    function abort() {
      clearTimeout(timer)
      reject(new DOMException("Aborted", "AbortError"))
    }
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
}
function Fixture() {
  const [done, setDone] = useState(false)
  return (
    <I18nProvider locale={params.get("locale") ?? "da-DK"}>
      {done ? (
        <p role="status">KLAR</p>
      ) : (
        <OnboardingV2
          userId="fixture-user"
          organizationId="fixture-org"
          signupEmail="billing@example.com"
          client={client}
          onComplete={() => setDone(true)}
        />
      )}
      <a href="/away.html">Leave onboarding</a>
    </I18nProvider>
  )
}
createRoot(document.getElementById("root")!).render(<Fixture />)
