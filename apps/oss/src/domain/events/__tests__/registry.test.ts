import { readdirSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { eventDefinition, eventRegistry, InvalidEvent, registerTestEventTypes, serializeEvent } from "../registry"
import { UnsupportedEventVersion, upcastEvent } from "../upcast"
import { emitterExpressions, reconstruct, variants } from "./emitter-fixtures"

type Fixture = {
  type: string; schemaVersion: number;
  cases: Array<{ source: string; typeExpression: string; payloadExpression: string; variant: string; payload: unknown }>
}
const directory = new URL("./fixtures/", import.meta.url)
const fixtures = readdirSync(directory).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(new URL(name, directory), "utf8")) as Fixture)

describe("versioned emitter inventory", () => {
  it("has fixture coverage for every registered production type and no extra types", () => {
    expect([...new Set(fixtures.map((fixture) => fixture.type))].sort()).toEqual(Object.keys(eventRegistry).sort())
  })
  for (const fixture of fixtures) {
    it(`${fixture.type} validates serialized payloads reconstructed from its actual writer expressions`, () => {
      const expressions = emitterExpressions()
      for (const sample of fixture.cases) {
        if (fixture.type === "credit_note.issued" && fixture.schemaVersion === 1) {
          const upcast = upcastEvent({ type: fixture.type, schemaVersion: 1, payload: sample.payload })
          expect(upcast).toMatchObject({ schemaVersion: 2, payload: { postable: false, incompleteReason: "historical_payload_incomplete" } })
          expect(eventDefinition(fixture.type)?.schema.safeParse(upcast.payload).success).toBe(true)
          continue
        }
        if (fixture.schemaVersion === eventDefinition(fixture.type)!.version) expect(expressions).toContainEqual({ source: sample.source, typeExpression: sample.typeExpression, payloadExpression: sample.payloadExpression })
        expect(reconstruct(sample, sample.variant)).toEqual({ type: fixture.type, payload: sample.payload })
        const current = upcastEvent({ type: fixture.type, schemaVersion: fixture.schemaVersion, payload: sample.payload })
        expect(serializeEvent(fixture.type, current.payload)).toEqual({ schemaVersion: current.schemaVersion, payload: current.payload })
      }
    })
  }
  it("covers every emitter expression and every reconstructed variant, including dynamic delivery types", () => {
    const covered = new Set(fixtures.flatMap((fixture) => fixture.cases.map((sample) => JSON.stringify({ source: sample.source, typeExpression: sample.typeExpression, payloadExpression: sample.payloadExpression, type: fixture.type, payload: sample.payload }))))
    for (const expression of emitterExpressions()) {
      for (const variant of variants) {
        const sample = reconstruct(expression, variant)
        expect(covered.has(JSON.stringify({ ...expression, ...sample })), JSON.stringify({ expression, variant })).toBe(true)
      }
    }
  })
})

describe("event envelope", () => {
  it("upcasts archived rebill evidence using only the one recorded credit and writes new events as v2", () => {
    const archived = JSON.parse(readFileSync(new URL("deliverable.rebill_authorized.v1.json", directory), "utf8")) as Fixture
    const payload = Object.freeze({ deliverableId: "document-1", invoiceId: "invoice-1", creditNoteId: "credit-note-1", generation: 1 })
    expect(archived.schemaVersion).toBe(1)
    expect(archived.cases[0].payload).toEqual(payload)
    const event = Object.freeze({ id: "historical-event", type: archived.type, schemaVersion: 1, payload })
    const expected = { ...event, schemaVersion: 2, payload: { ...payload, creditNoteIds: ["credit-note-1"] } }
    expect(upcastEvent(event)).toEqual(expected)
    expect(upcastEvent(event)).toEqual(expected)
    expect(event.payload).not.toHaveProperty("creditNoteIds")
    expect(event.schemaVersion).toBe(1)
    expect(serializeEvent(event.type, expected.payload)).toEqual({ schemaVersion: 2, payload: expected.payload })
    const cumulative = { ...payload, creditNoteIds: ["credit-note-1", "credit-note-2"] }
    expect(serializeEvent(event.type, cumulative)).toEqual({ schemaVersion: 2, payload: cumulative })
    expect(() => serializeEvent(event.type, payload)).toThrow(InvalidEvent)
    expect(() => serializeEvent(event.type, { ...payload, creditNoteIds: [] })).toThrow(InvalidEvent)
    expect(() => serializeEvent(event.type, { ...cumulative, extra: true })).toThrow(InvalidEvent)
  })
  it("validates after JSON serialization, retains the original serialized value and refuses unknown types", () => {
    const payload = { number: "INV-1", ignored: undefined, toJSON: () => ({ number: "INV-1" }) }
    expect(serializeEvent("invoice.draft_deleted", payload)).toEqual({ schemaVersion: 1, payload: { number: "INV-1" } })
    expect(() => serializeEvent("invoice.draft_deleted", { number: 1 })).toThrow(InvalidEvent)
    expect(() => serializeEvent("invoice.draft_deleted", { number: "1", extra: true })).toThrow(InvalidEvent)
    expect(() => serializeEvent("missing.event", {})).toThrow(InvalidEvent)
    expect(() => serializeEvent("invoice.draft_deleted", { number: 1n })).toThrow(InvalidEvent)
  })
  it("does not register test.pinged in production and forbids test registrations outside tests", () => {
    expect(eventDefinition("test.pinged")).toBeUndefined()
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = "production"
    try { expect(() => registerTestEventTypes({})).toThrow("NODE_ENV=test") }
    finally { process.env.NODE_ENV = previous }
    expect(() => registerTestEventTypes({ "contact.created": eventRegistry["contact.created"] })).toThrow()
  })
  it("upcasts historical creation events and refuses unsupported versions", () => {
    for (const fixture of fixtures) {
      const envelope = { type: fixture.type, schemaVersion: fixture.schemaVersion, payload: fixture.cases[0].payload }
      if (fixture.type === "credit_note.issued" && fixture.schemaVersion === 1) expect(upcastEvent(envelope)).toMatchObject({ schemaVersion: 2, payload: { postable: false } })
      else if (fixture.type === "agreement.draft_created" && fixture.schemaVersion === 1) {
        expect(upcastEvent(envelope)).toMatchObject({ schemaVersion: 2, payload: { ...fixture.cases[0].payload as object, sourceQuoteId: null } })
        expect(envelope.payload).not.toHaveProperty("sourceQuoteId")
      } else if (fixture.type === "deliverable.rebill_authorized" && fixture.schemaVersion === 1) {
        expect(upcastEvent(envelope)).toMatchObject({ schemaVersion: 2, payload: { ...fixture.cases[0].payload as object, creditNoteIds: ["credit-note-1"] } })
        expect(envelope.payload).not.toHaveProperty("creditNoteIds")
      } else expect(upcastEvent(envelope)).toBe(envelope)
      expect(() => upcastEvent({ ...envelope, schemaVersion: eventDefinition(fixture.type)!.version + 1 })).toThrow(UnsupportedEventVersion)
      expect(() => upcastEvent({ ...envelope, schemaVersion: 0 })).toThrow(UnsupportedEventVersion)
    }
    expect(() => upcastEvent({ type: "unknown", schemaVersion: 1, payload: {} })).toThrow(UnsupportedEventVersion)
  })
})
