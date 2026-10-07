import { eventDefinition, type EventType } from "./registry"

export class UnsupportedEventVersion extends Error {
  override readonly name = "UnsupportedEventVersion"
  constructor(readonly type: string, readonly schemaVersion: number) {
    super(`Unsupported event version ${type} v${schemaVersion}`)
  }
}

type Envelope = { type: string; schemaVersion: number; payload: unknown }
type Transform = (payload: unknown) => unknown
/** Key N transforms a payload from N to N+1. Transforms must be pure and total. */
const transforms: Partial<Record<EventType, Record<number, Transform>>> = {}

/** Known v1 envelopes are unchanged. Unknown types, invalid versions and missing steps refuse. */
export function upcastEvent<T extends Envelope>(event: T): Omit<T, "schemaVersion" | "payload"> & Envelope {
  const definition = eventDefinition(event.type)
  if (!definition || !Number.isInteger(event.schemaVersion) || event.schemaVersion < 1 || event.schemaVersion > definition.version) {
    throw new UnsupportedEventVersion(event.type, event.schemaVersion)
  }
  if (event.schemaVersion === definition.version) return event
  let payload = event.payload
  for (let version = event.schemaVersion; version < definition.version; version++) {
    const transform = transforms[event.type as EventType]?.[version]
    if (!transform) throw new UnsupportedEventVersion(event.type, version)
    payload = transform(payload)
  }
  return { ...event, schemaVersion: definition.version, payload }
}
