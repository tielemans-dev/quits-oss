import type { CvrCompany, OnboardingSuggestions } from "@quits/contracts/cvr"

// Selected DB07 and DB25 industry groups. Unknown codes deliberately produce no guesses.
const starters: Record<string, [string[], string[], "hour" | "each"]> = {
  "41": [["Byggearbejde"], ["Virksomheder", "Private boligejere"], "hour"],
  "42": [["Anlægsarbejde"], ["Virksomheder"], "hour"],
  "43": [["Håndværksarbejde"], ["Virksomheder", "Private boligejere"], "hour"],
  "6201": [["Softwareudvikling", "IT-rådgivning"], ["Virksomheder"], "hour"],
  "6210": [["Softwareudvikling", "IT-rådgivning"], ["Virksomheder"], "hour"],
  "6202": [["IT-rådgivning"], ["Virksomheder"], "hour"],
  "6220": [["IT-rådgivning"], ["Virksomheder"], "hour"],
  "702": [["Virksomhedsrådgivning"], ["Virksomheder"], "hour"],
  "741": [["Designarbejde"], ["Virksomheder"], "hour"],
  "812": [["Rengøring"], ["Virksomheder", "Private husstande"], "hour"],
  "813": [["Havearbejde"], ["Virksomheder", "Private boligejere"], "hour"],
}

export function companyStarters(company: CvrCompany): OnboardingSuggestions {
  if (company.status !== "active" || company.statusClass !== "active") return { customers: [], lines: [] }
  const code = company.industryCode ?? company.industry?.match(/^\d{6}(?=\D|$)/)?.[0]
  const entry = code && (starters[code.slice(0, 4)] ?? starters[code.slice(0, 3)] ?? starters[code.slice(0, 2)])
  if (!entry) return { customers: [], lines: [] }
  const [lines, customers, unit] = entry
  return {
    customers: customers.map((label, i) => ({ id: `industry-customer-${i}`, label })),
    lines: lines.map((description, i) => ({ id: `industry-line-${i}`, description, unit, unitPrice: 0 })),
  }
}
