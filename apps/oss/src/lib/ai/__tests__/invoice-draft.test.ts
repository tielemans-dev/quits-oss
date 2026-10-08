import { describe, expect, it } from "vitest"
import { AiProviderError, type AiProvider } from "../provider"
import {
  extractJsonObjectFromText,
  generateInvoiceDraft,
  parseInvoiceDraftFromModelOutput,
  readModelNumber,
} from "../invoice-draft"

function fakeProvider(complete: AiProvider["complete"]): AiProvider {
  return { id: "openrouter", complete }
}

const draftInput = {
  model: "openai/gpt-4o-mini",
  prompt: "Create a draft invoice for consulting work",
  todayIsoDate: "2026-03-03",
  contacts: [],
  catalogItems: [],
}

describe("invoice draft parsing", () => {
  it("extracts json object from markdown fenced output", () => {
    const text = "Here you go:\n```json\n{\"notes\":\"Test\",\"items\":[{\"description\":\"Dev\",\"quantity\":2,\"unitPrice\":100}]}\n```"
    expect(extractJsonObjectFromText(text)).toBe(
      '{"notes":"Test","items":[{"description":"Dev","quantity":2,"unitPrice":100}]}'
    )
  })

  it("parses and normalizes invoice draft payload", () => {
    const draft = parseInvoiceDraftFromModelOutput(
      '{"contactId":"c1","contactName":"Acme","dueDate":"2030-01-20","taxRate":25,"notes":"Net 14","items":[{"description":"Design","quantity":1,"unitPrice":1200,"catalogItemId":"i1"}]}'
    )

    expect(draft.contactId).toBe("c1")
    expect(draft.contactName).toBe("Acme")
    expect(draft.taxRate).toBe(25)
    expect(draft.items).toEqual([
      { description: "Design", quantity: 1, unitPrice: 1200, catalogItemId: "i1" },
    ])
  })

  it("allows invoice items without unitPrice", () => {
    const draft = parseInvoiceDraftFromModelOutput(
      '{"items":[{"description":"1 gangs fræsning","quantity":1,"catalogItemId":"cat-1"}]}'
    )

    expect(draft.items).toEqual([
      { description: "1 gangs fræsning", quantity: 1, catalogItemId: "cat-1" },
    ])
  })

  it("allows invoice items without description", () => {
    const draft = parseInvoiceDraftFromModelOutput(
      '{"items":[{"quantity":1,"catalogItemId":"cat-1"}]}'
    )

    expect(draft.items).toEqual([{ quantity: 1, catalogItemId: "cat-1" }])
  })

  it("throws when model output has no parseable invoice items", () => {
    expect(() => parseInvoiceDraftFromModelOutput("not-json")).toThrow()
    expect(() => parseInvoiceDraftFromModelOutput('{"items":[]}')).toThrow()
    expect(() => parseInvoiceDraftFromModelOutput('{"items":[{"quantity":-1}],"notes":"x"}')).not.toThrow()
    expect(() => parseInvoiceDraftFromModelOutput('{"notes":"no items"}')).toThrow()
  })

  it("treats null and unusable optional fields as absent", () => {
    // gpt-4o-mini writes null for keys it has no value for, such as the contact of an
    // organisation with no contacts.
    const draft = parseInvoiceDraftFromModelOutput(
      JSON.stringify({
        contactId: null,
        contactName: null,
        dueDate: "in 14 days",
        taxRate: null,
        notes: "",
        items: [{ description: null, quantity: 5, unitPrice: 5000, catalogItemId: null }],
      })
    )

    expect(draft).toEqual({ items: [{ quantity: 5, unitPrice: 5000 }] })
  })

  it("reads numbers written as text, including Danish thousands separators", () => {
    const draft = parseInvoiceDraftFromModelOutput(
      '{"taxRate":"25%","items":[{"description":"Produkt","quantity":"5","unitPrice":"5.000 kr"}]}'
    )

    expect(draft).toEqual({
      taxRate: 25,
      items: [{ description: "Produkt", quantity: 5, unitPrice: 5000 }],
    })
  })

  it("defaults a missing quantity to one and accepts name and price for an item", () => {
    const draft = parseInvoiceDraftFromModelOutput('{"items":[{"name":"Produkt","price":5000}]}')

    expect(draft.items).toEqual([{ description: "Produkt", quantity: 1, unitPrice: 5000 }])
  })

  it("unwraps a draft the model nested in another object", () => {
    const draft = parseInvoiceDraftFromModelOutput('{"invoice":{"items":[{"quantity":2}]}}')

    expect(draft.items).toEqual([{ quantity: 2 }])
  })

  it("keeps the usable items and truncates over-long text", () => {
    const draft = parseInvoiceDraftFromModelOutput(
      JSON.stringify({ items: ["junk", { quantity: 1, description: "x".repeat(600) }] })
    )

    expect(draft.items).toEqual([{ quantity: 1, description: "x".repeat(500) }])
  })
})

describe("readModelNumber", () => {
  it.each([
    [5000, 5000],
    ["5000", 5000],
    ["5.000", 5000],
    ["5,000", 5000],
    ["1.234.567", 1234567],
    ["1.234,50", 1234.5],
    ["1,234.50", 1234.5],
    ["12,5", 12.5],
    ["12.5", 12.5],
    ["0.250", 0.25],
    ["5000.00", 5000],
    ["DKK 5.000,-", 5000],
    ["-3", -3],
  ])("reads %j as %d", (input, expected) => {
    expect(readModelNumber(input)).toBe(expected)
  })

  it.each([[null], [undefined], ["about"], [Number.NaN], [{}]])("reads %j as undefined", (input) => {
    expect(readModelNumber(input)).toBeUndefined()
  })
})

describe("generateInvoiceDraft", () => {
  it("sends the system prompts, context and user prompt, then returns the parsed draft", async () => {
    let received: unknown = null
    const provider = fakeProvider(async (request) => {
      received = request
      return '{"contactName":"Acme","items":[{"quantity":2,"unitPrice":100}]}'
    })

    const draft = await generateInvoiceDraft({
      ...draftInput,
      provider,
      contacts: [{ id: "c1", name: "Acme" }],
      catalogItems: [{ id: "i1", name: "Dev", defaultUnitPrice: 100 }],
    })

    expect(draft).toEqual({ contactName: "Acme", items: [{ quantity: 2, unitPrice: 100 }] })
    expect(received).toMatchObject({
      model: "openai/gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system" },
        { role: "system", content: expect.stringContaining('"availableContacts"') },
        { role: "user", content: "Create a draft invoice for consulting work" },
      ],
    })
    expect((received as { messages: Array<{ content: string }> }).messages[0]?.content).toContain(
      "Today is 2026-03-03"
    )
  })

  it("drafts five products at about 5,000 kroner from the user's Danish prompt", async () => {
    const prompt =
      "La la la. Jeg kan godt lide kage. Jeg har solgt et produkt til omkring 5.000 kroner. Jeg har faktisk solgt fem af dem."
    let received: { messages: Array<{ role: string; content: string }> } | null = null
    // What gpt-4o-mini answered for an organisation with no contacts or catalog items.
    const provider = fakeProvider(async (request) => {
      received = request
      return '```json\n{"contactId":null,"contactName":null,"dueDate":null,"taxRate":null,"notes":null,"items":[{"catalogItemId":null,"description":"Produkt","quantity":5,"unitPrice":5000}]}\n```'
    })

    const draft = await generateInvoiceDraft({ ...draftInput, provider, prompt })

    expect(draft).toEqual({ items: [{ description: "Produkt", quantity: 5, unitPrice: 5000 }] })
    const system = received!.messages[0]!.content
    expect(system).toContain("never use null")
    expect(system).toContain('"5.000 kroner" is 5000')
    expect(received!.messages[2]).toEqual({ role: "user", content: prompt })
  })

  it("throws invalid_response with the provider id when the model output cannot be parsed", async () => {
    const provider = fakeProvider(async () => "I cannot help with that")

    await expect(generateInvoiceDraft({ ...draftInput, provider })).rejects.toMatchObject({
      name: "AiProviderError",
      code: "invalid_response",
      providerId: "openrouter",
      message: expect.stringContaining("the output is not JSON"),
    })
  })

  it("passes provider errors through unchanged", async () => {
    const provider = fakeProvider(async () => {
      throw new AiProviderError({ code: "empty_response", providerId: "openrouter", message: "empty" })
    })

    await expect(generateInvoiceDraft({ ...draftInput, provider })).rejects.toMatchObject({
      code: "empty_response",
    })
  })
})
