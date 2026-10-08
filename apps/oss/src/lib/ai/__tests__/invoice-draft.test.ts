import { describe, expect, it } from "vitest"
import { AiProviderError, type AiProvider } from "../provider"
import {
  extractJsonObjectFromText,
  generateInvoiceDraft,
  parseInvoiceDraftFromModelOutput,
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

  it("throws invalid_response with the provider id when the model output cannot be parsed", async () => {
    const provider = fakeProvider(async () => "I cannot help with that")

    await expect(generateInvoiceDraft({ ...draftInput, provider })).rejects.toMatchObject({
      name: "AiProviderError",
      code: "invalid_response",
      providerId: "openrouter",
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
