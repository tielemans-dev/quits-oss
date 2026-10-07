import { createHash } from "node:crypto"

export function hashBytes(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}
