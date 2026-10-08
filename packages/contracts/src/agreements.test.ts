import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  agreementCreateDraftInputSchema,
  agreementUpdateDraftInputSchema,
  deliverableUpdateInputSchema,
} from "@quits/contracts/agreements"

describe("agreement contracts", () => {
  it("validates real calendar dates and refuses unauthorized lifecycle fields", () => {
    const input = { contactId: "buyer", title: "Design", validUntil: "2026-10-31" }
    expect(agreementCreateDraftInputSchema.parse(input)).toMatchObject({
      deliverables: [],
      billingTrigger: "on_acceptance",
    })
    for (const invalid of ["2026-02-30", "tomorrow"]) {
      expect(
        agreementCreateDraftInputSchema.safeParse({ ...input, validUntil: invalid }).success,
      ).toBe(false)
    }
    expect(
      agreementCreateDraftInputSchema.safeParse({ ...input, status: "accepted" }).success,
    ).toBe(false)
    expect(
      deliverableUpdateInputSchema.safeParse({
        id: "line",
        agreementId: "agreement",
        status: "delivered",
      }).success,
    ).toBe(false)
  })
  it("allows only the update fulfillment transition, preserving zero create defaults", () => {
    expect(
      deliverableUpdateInputSchema.parse({ id: "line", agreementId: "a", status: "in_progress" }),
    ).toEqual({ id: "line", agreementId: "a", status: "in_progress" })
    for (const field of [
      { status: "cancelled" },
      { deliveryRevision: 2 },
      { acceptedAt: "2026-10-07" },
      { billingStatus: "invoiced" },
    ])
      expect(
        deliverableUpdateInputSchema.safeParse({ id: "line", agreementId: "a", ...field }).success,
      ).toBe(false)
  })
  it("preserves omitted draft and deliverable fields instead of applying create defaults", () => {
    expect(agreementUpdateDraftInputSchema.parse({ id: "a", notes: "private" })).toEqual({
      id: "a",
      notes: "private",
    })
    expect(
      deliverableUpdateInputSchema.parse({ id: "l", agreementId: "a", expectedDate: null }),
    ).toEqual({ id: "l", agreementId: "a", expectedDate: null })
  })
  it("imports the agreements subpath and barrel from the packed artifact", () => {
    const packageDir = fileURLToPath(new URL("..", import.meta.url))
    const fixture = mkdtempSync(path.join(tmpdir(), "quits-agreements-pack-"))
    try {
      execFileSync("bun", ["pm", "pack", "--destination", fixture], {
        cwd: packageDir,
        stdio: "pipe",
      })
      const tarball = readdirSync(fixture).find((name) => name.endsWith(".tgz"))!
      const modules = path.join(fixture, "node_modules")
      const target = path.join(modules, "@quits", "contracts")
      mkdirSync(target, { recursive: true })
      execFileSync("tar", [
        "-xzf",
        path.join(fixture, tarball),
        "--strip-components=1",
        "-C",
        target,
      ])
      symlinkSync(path.join(packageDir, "node_modules", "zod"), path.join(modules, "zod"), "dir")
      const output = execFileSync(
        "bun",
        [
          "-e",
          'import { agreementCreateDraftInputSchema as subpath } from "@quits/contracts/agreements"; import { agreementCreateDraftInputSchema as barrel } from "@quits/contracts"; if (subpath !== barrel) throw new Error("barrel mismatch"); console.log(subpath.parse({contactId:"buyer", title:"Design", validUntil:"2026-10-31"}).billingTrigger)',
        ],
        { cwd: fixture, encoding: "utf8" },
      )
      expect(output.trim()).toBe("on_acceptance")
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
