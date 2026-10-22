import { z } from "zod"
import type { CvrCompany } from "@quits/contracts/cvr"

/** The customer identity and registered address the CVR register answers for. */
export const registryFactsSchema = z.object({
  cvr: z.string().regex(/^\d{8}$/),
  legalName: z.string().min(1).max(120),
  secondaryNames: z.array(z.string().min(1).max(120)).max(20).default([]),
  address: z.string().max(240),
  zip: z.string().max(20),
  city: z.string().max(120),
})
export type RegistryFacts = z.infer<typeof registryFactsSchema>

/** "Vestergade 1, 2100 København Ø" or the same over two lines: street first, then postnr and by. */
export const addressLines = (address: string) =>
  address.split(/\n|,\s*(?=\d{4}\s)/).map((line) => line.trim()).filter(Boolean)

export function registryFacts(company: CvrCompany): RegistryFacts {
  const [street = "", place = ""] = addressLines(company.address)
  const postal = /^(\d{4})\s+(.+)$/.exec(place)
  return { cvr: company.cvr, legalName: company.name, secondaryNames: company.secondaryNames ?? [], address: street, zip: postal?.[1] ?? "", city: postal?.[2] ?? place }
}

/** The name a CVR customer is invoiced under: `wanted` when it is one of the register's names, else the legal name. */
export function registryName(registry: { legalName: string; secondaryNames: readonly string[] }, wanted: string | null | undefined) {
  return wanted && registry.secondaryNames.includes(wanted) ? wanted : registry.legalName
}

/** A stored CVR as its eight digits: "DK 24 25 67 90" is "24256790". */
export const cvrDigits = (value: string | null | undefined) => (value ?? "").replace(/^DK\s*/i, "").replace(/[\s.\-/]/g, "")
