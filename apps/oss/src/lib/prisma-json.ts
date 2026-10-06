import { Prisma } from "../../generated/prisma/client"

/**
 * Converts a JSON value read from Prisma into a value Prisma accepts on write.
 * Database nulls must be written back as `Prisma.DbNull`, not `null`.
 */
export function toNullableJsonInput(
  value: Prisma.JsonValue | null | undefined
): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  if (value === undefined) {
    return undefined
  }

  return value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue)
}
