import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

it("imports pricing and currency with contracts from packed artifacts outside the workspace", () => {
  const packageDir = fileURLToPath(new URL("../..", import.meta.url))
  const contractsDir = path.resolve(packageDir, "../contracts")
  const fixture = mkdtempSync(path.join(tmpdir(), "quits-pricing-pack-"))
  try {
    const modules = path.join(fixture, "node_modules")
    for (const [name, source] of [["shared", packageDir], ["contracts", contractsDir]]) {
      const packDir = path.join(fixture, name!)
      mkdirSync(packDir)
      execFileSync("bun", ["pm", "pack", "--destination", packDir], { cwd: source, stdio: "pipe" })
      const tarball = readdirSync(packDir).find((name) => name.endsWith(".tgz"))!
      const target = path.join(modules, "@quits", name!)
      mkdirSync(target, { recursive: true })
      execFileSync("tar", ["-xzf", path.join(packDir, tarball), "--strip-components=1", "-C", target])
    }
    symlinkSync(path.join(packageDir, "node_modules", "decimal.js-light"), path.join(modules, "decimal.js-light"), "dir")
    symlinkSync(path.join(contractsDir, "node_modules", "zod"), path.join(modules, "zod"), "dir")
    const output = execFileSync("bun", ["-e", `
      import { calculateDocument, creditComponents } from "@quits/shared/pricing";
      import { requireCurrencyExponent } from "@quits/shared/currency";
      import { calculateDocumentInputSchema, calculateDocumentOutputSchema } from "@quits/contracts/pricing";
      import { vatTreatmentSchema } from "@quits/contracts/vat";
      import { vatTreatmentSchema as barrel } from "@quits/contracts";
      if (barrel !== vatTreatmentSchema || requireCurrencyExponent("DKK") !== 2) throw Error("export mismatch");
      const result = calculateDocument(calculateDocumentInputSchema.parse({currency:"DKK",lines:[{quantity:"1",unitPrice:"0.01",sortOrder:0,vat:{treatment:"standard",rate:"0.25"}}]}));
      calculateDocumentOutputSchema.parse(result);
      console.log(creditComponents({group:result.groups[0],cumulativeBefore:"0",creditedGross:"0.01"}).gross);
    `], { cwd: fixture, encoding: "utf8" })
    expect(output.trim()).toBe("0.01")
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
