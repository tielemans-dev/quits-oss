import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const script = fileURLToPath(new URL("../prepare-number-rollback.mjs", import.meta.url))

function run(args: string[], databaseUrl: string) {
  // An empty value is kept as it is: the workspace .env never overrides a variable that is already set.
  const env = { ...process.env, DATABASE_URL: databaseUrl }
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

// Every refusal happens before the script connects, so these need no database.
describe("prepare-number-rollback", () => {
  it("does nothing without --dry-run or --confirm", () => {
    const result = run([], "postgresql://user:hunter2pw@127.0.0.1:1/shop")
    expect(result.status).toBe(1)
    expect(result.output).toContain("Usage:")
  })

  it("refuses a confirmation that is not the database name", () => {
    const result = run(["--confirm", "other"], "postgresql://user:hunter2pw@127.0.0.1:1/shop")
    expect(result.status).toBe(1)
    expect(result.output).toContain("--confirm must be the database name (shop)")
    expect(result.output).not.toContain("hunter2pw")
  })

  it("refuses a bare --confirm", () => {
    expect(run(["--confirm"], "postgresql://user:hunter2pw@127.0.0.1:1/shop").status).toBe(1)
  })

  it("needs DATABASE_URL", () => {
    const result = run(["--dry-run"], "")
    expect(result.status).toBe(1)
    expect(result.output).toContain("DATABASE_URL is")
  })
})
