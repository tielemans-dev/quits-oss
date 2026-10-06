import { SuperJSON } from "superjson"
import { Prisma } from "../../generated/prisma/client"

/**
 * Command results are stored on receipts so retries can replay them. A dedicated SuperJSON
 * instance keeps Dates and Prisma Decimals intact, so a replayed result is identical to the
 * first response.
 */
const receiptJson = new SuperJSON()
receiptJson.registerCustom<Prisma.Decimal, string>(
  {
    isApplicable: (value): value is Prisma.Decimal => Prisma.Decimal.isDecimal(value),
    serialize: (value) => value.toString(),
    deserialize: (value) => new Prisma.Decimal(value),
  },
  "prisma.decimal"
)

export function serializeResult(value: unknown): Prisma.InputJsonValue {
  return receiptJson.serialize(value ?? null) as unknown as Prisma.InputJsonValue
}

export function deserializeResult<T>(value: Prisma.JsonValue): T {
  if (value && typeof value === "object" && "json" in value) {
    return receiptJson.deserialize(value as unknown as Parameters<typeof receiptJson.deserialize>[0])
  }
  return value as T
}
