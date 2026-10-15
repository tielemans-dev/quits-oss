import { describe, expect, it } from "vitest"
import { translate } from "../../i18n/translate"
import { readableIssues } from "../readable-errors"
import { companyEmailIssue } from "../company-email"

const zod = (...issues: object[]) => new Error(JSON.stringify(issues))
const texts = (error: unknown, locale: string) =>
  (readableIssues(error) ?? []).map((issue) => translate(issue.key, locale, issue.params))

describe("readableIssues", () => {
  it.each([
    ["contact", { path: ["contactId"], code: "too_small" }, "Choose a customer", "Vælg en kunde"],
    ["empty lines", { path: ["items"], code: "too_small" }, "Add at least one line", "Tilføj mindst én linje"],
    ["description", { path: ["items", 1, "description"], code: "too_small" }, "Describe what you're invoicing for", "Beskriv, hvad du fakturerer for"],
    ["quantity", { path: ["items", 0, "quantity"], code: "invalid_type" }, "Enter a quantity, like 1 or 2.5", "Indtast et antal, fx 1 eller 2,5"],
    ["price", { path: ["items", 0, "unitPrice"], code: "invalid_type" }, "Enter a price, like 1250.00", "Indtast en pris, fx 1250,00"],
    ["date", { path: ["dueDate"], code: "invalid_format" }, "Enter a date, like 10/24/2026", "Indtast en dato, fx 24.10.2026"],
    ["due before issue", { path: ["dueDate"], code: "custom", message: "dueDate.beforeIssue" }, "Due date must be after the invoice date", "Forfaldsdatoen skal ligge efter fakturadatoen"],
    ["cvr", { path: ["cvr"], code: "custom", message: "cvr.invalid" }, "A CVR number has 8 digits", "Et CVR-nummer har 8 cifre"],
    ["email", { path: ["email"], code: "invalid_format", format: "email" }, "Enter a valid email, like name@company.com", "Indtast en gyldig e-mail, fx navn@firma.dk"],
    ["too long", { path: ["notes"], code: "too_big", maximum: 500, origin: "string" }, "500 characters max", "Højst 500 tegn"],
    ["notes too long", { path: ["notes"], code: "too_big", maximum: 5000, origin: "string" }, "5000 characters max", "Højst 5000 tegn"],
    ["unmapped", { path: ["somethingElse"], code: "weird" }, "Check this field and try again", "Tjek feltet og prøv igen"],
  ])("maps %s in English and Danish", (_name, issue, en, da) => {
    expect(texts(zod(issue), "en")).toEqual([en])
    expect(texts(zod(issue), "da")).toEqual([da])
  })

  it("routes line VAT issues to the line's VAT column", () => {
    expect(readableIssues(zod({ path: ["items", 2, "vat", "rate"], code: "custom" }))).toEqual([{ field: "items", line: 2, column: "vat", key: "validation.unknown" }])
  })

  it("keeps one issue when a value fails several checks", () => {
    expect(texts(zod({ path: ["items", 0, "quantity"], code: "invalid_format" }, { path: ["items", 0, "quantity"], code: "too_small" }, { path: ["items", 1, "quantity"], code: "too_small" }), "en"))
      .toEqual(["Enter a quantity, like 1 or 2.5", "Enter a quantity, like 1 or 2.5"])
  })

  it("routes notes issues to the notes field", () => {
    expect(readableIssues(zod({ path: ["notes"], code: "too_big", maximum: 5000, origin: "string" }))?.[0]?.field).toBe("notes")
  })

  it("keeps the line and column an issue belongs to", () => {
    expect(readableIssues(zod({ path: ["items", 2, "quantity"], code: "invalid_type" }))).toEqual([
      { field: "items", line: 2, column: "quantity", key: "validation.line.qty.invalid" },
    ])
  })

  it("never lets structured payloads through, even when they are malformed or empty", () => {
    for (const message of ["[{not json", "{}", "[]", '{"issues":[]}']) {
      expect(texts(new Error(message), "en")).toEqual(["Check this field and try again"])
    }
    expect(texts(zod({ message: '[{"raw":"json"}]' }), "en")[0]).not.toMatch(/[[{]/)
  })

  it("only uses the character limit message for string issues", () => {
    const tooBigItems = { path: ["items"], code: "too_big", maximum: 100, origin: "array" }
    expect(texts(zod(tooBigItems), "en")).toEqual(["Check this field and try again"])
    expect(texts(zod({ path: ["notes"], code: "too_big", maximum: 100, origin: "number" }), "en")).toEqual(["Check this field and try again"])
  })

  it("skips non-object entries instead of throwing", () => {
    for (const message of ["[null]", '{"issues":[null]}', '[1,"x",[]]', '{"issues":[null,{"path":["contactId"]}]}']) {
      expect(() => readableIssues(new Error(message))).not.toThrow()
    }
    expect(texts(new Error("[null]"), "en")).toEqual(["Check this field and try again"])
    expect(texts(new Error('{"issues":[null,{"path":["contactId"]}]}'), "en")).toEqual(["Choose a customer"])
  })

  it("reads issues nested under an issues key", () => {
    expect(texts(new Error(JSON.stringify({ issues: [{ path: ["contactId"] }] })), "en")).toEqual(["Choose a customer"])
  })

  it("leaves plain-text server messages to the caller", () => {
    expect(readableIssues(new Error("Invoice is not editable"))).toBeNull()
    expect(readableIssues(undefined)).toBeNull()
  })
})

describe("companyEmailIssue", () => {
  it.each([
    ["", "validation.email.required"],
    ["   ", "validation.email.required"],
    ["not-an-email", "validation.email.invalid"],
    ["a@b", "validation.email.invalid"],
    ["name@company.com", null],
    [" name@company.com ", null],
  ])("classifies %j", (value, expected) => {
    expect(companyEmailIssue(value)).toBe(expected)
  })
})
