import { createElement, forwardRef, type ReactNode } from "react"

const params = new URLSearchParams(location.search)
const navigate = () => {}
const session = {
  data: {
    user: { id: "screen-user", email: "billing@example.com" },
    session: { activeOrganizationId: "screen-org" },
  },
}
export const createFileRoute = () => (options: unknown) => options
export const useNavigate = () => navigate
export const useRouter = () => ({ invalidate() {} })
export const Link = forwardRef<HTMLAnchorElement, Record<string, unknown>>(
  ({ to, children, params: _params, search: _search, ...props }, ref) =>
    createElement("a", { ...props, href: to, ref }, children as ReactNode),
)
export const useRuntimeDistribution = () => ({
  isCloud: true,
  isSelfHost: false,
  distribution: "cloud",
})
export const useSession = () => session
export const authClient = {
  organization: { list: async () => ({ data: [] }), setActive: async () => ({}) },
  getSession: async () => useSession(),
}
export const trpc = {
  onboarding: {
    getStatus: {
      query: async () => ({
        status: "in_progress",
        isComplete: false,
        missing: [],
        values: {
          companyName: "Nordlys Studio ApS",
          companyAddress: "Nørrebrogade 12, 2. tv.\n2200 København N",
          companyEmail: "billing@example.com",
          countryCode: "DK",
          invoicingIdentity: "registered_business",
          locale: "da-DK",
          timezone: "Europe/Copenhagen",
          defaultCurrency: "DKK",
          taxRegime: "eu_vat",
          pricesIncludeTax: false,
          invoicePrefix: "INV",
          quotePrefix: "QTE",
          primaryTaxId: "24256790",
          primaryTaxIdScheme: "cvr",
        },
      }),
    },
    saveDraft: { mutate: async () => ({}) },
    completeManual: { mutate: async () => ({}) },
  },
  runtime: { capabilities: { query: async () => ({ onboardingAi: { enabled: false } }) } },
  paymentDetails: {
    firstSendReadiness: {
      query: async () => ({ bankMissing: params.get("state") === "bank-nudge" }),
    },
  },
}
