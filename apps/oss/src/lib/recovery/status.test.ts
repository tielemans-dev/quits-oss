import { describe, expect, it } from "vitest"
import { collectOperationalStatus } from "./status"
import type { QueryFn } from "./pgdb"

const now = new Date("2026-10-08T12:00:00Z")
const old = "2026-09-01T12:00:00Z"

async function status(records: Array<Record<string, unknown>>) {
  const query: QueryFn = async (sql) => sql.includes("FROM backup_record") ? records : []
  return (await collectOperationalStatus({ query, env: {}, environmentHold: true, artifactCheckLimit: 0, now })).backups
}

describe("backup snapshot age", () => {
  it("does not refresh a 37-day-old snapshot when it is verified today", async () => {
    const backups = await status([
      { kind: "created", at: old, snapshotAt: old },
      { kind: "verified", at: now, snapshotAt: old },
    ])
    expect(backups).toMatchObject({ ageHours: 888, stale: true, verificationAgeHours: 0, newestSnapshotAt: new Date(old).toISOString() })
  })

  it("keeps the newer snapshot when an older bundle is verified later", async () => {
    const recent = "2026-10-08T06:00:00Z"
    expect(await status([
      { kind: "created", at: recent, snapshotAt: recent },
      { kind: "verified", at: now, snapshotAt: old },
    ])).toMatchObject({ ageHours: 6, stale: false, verificationAgeHours: 0, newestSnapshotAt: new Date(recent).toISOString() })
  })

  it("does not invent snapshot freshness for missing or invalid dates", async () => {
    expect(await status([{ kind: "verified", at: now, snapshotAt: "invalid" }])).toMatchObject({ ageHours: null, stale: true })
    expect(await status([{ kind: "verified", at: now }])).toMatchObject({ ageHours: null, stale: true })
  })
})
