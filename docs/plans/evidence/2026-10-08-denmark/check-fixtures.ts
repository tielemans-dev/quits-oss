// Run from the repository root with Bun. No network, credentials or database.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { buildUblDocument, validateEinvoice, type EinvoiceDocument } from "../../../../apps/oss/src/lib/exports/ubl"

const inputs = JSON.parse(readFileSync(new URL("./inputs.json", import.meta.url), "utf8")) as Record<string, EinvoiceDocument>
for (const [name, input] of Object.entries(inputs)) {
  assert.deepEqual(validateEinvoice(input), [], `${name}: Quits validation`)
  const expected = readFileSync(new URL(`./xml/${name}.xml`, import.meta.url), "utf8")
  assert.equal(buildUblDocument(input), expected, `${name}: output differs from the recorded fixture`)
  console.log(`${name}: validation passed; XML matches recorded bytes`)
}

const invoice = readFileSync(new URL("./xml/dk-b2b-invoice.xml", import.meta.url), "utf8")
const controls = {
  "negative-control": invoice
    .replace("<cbc:PaymentMeansCode>42</cbc:PaymentMeansCode>", "<cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>")
    .replace(/\s*<cbc:BuyerReference>[^<]*<\/cbc:BuyerReference>/, ""),
  "negative-control-2": invoice
    .replace(/\s*<cbc:BuyerReference>[^<]*<\/cbc:BuyerReference>/, "")
    .replace(/\s*<cac:OrderReference>[\s\S]*?<\/cac:OrderReference>/, "")
    .replace(/\s*<cac:PartyLegalEntity>[\s\S]*?<\/cac:PartyLegalEntity>/, ""),
}
for (const [name, xml] of Object.entries(controls)) {
  const path = fileURLToPath(new URL(`./xml/${name}.xml`, import.meta.url))
  // The preserved controls differ in whitespace; XML content is the evidence.
  const normalize = (value: string) => value.replace(/>\s+</g, "><").trim()
  assert.equal(normalize(xml), normalize(readFileSync(path, "utf8")), `${name}: negative-control content`)
  console.log(`${name}: recorded invalid content matches the documented mutation`)
}
