#!/usr/bin/env node

import dotenv from "dotenv"
import { createRequire } from "node:module"
import { databaseNameOf, prepareNumberRollback } from "./number-rollback-lib.mjs"
import { resolveDatabaseTarget } from "./predev-bootstrap-lib.mjs"
import { discoverWorkspaceEnvFile } from "./workspace-env.js"

const USAGE = `Usage: node scripts/prepare-number-rollback.mjs --dry-run
       node scripts/prepare-number-rollback.mjs --confirm <database name>

Prepares the database for rolling back "numbers are assigned when a document is issued": gives
every invoice and quote draft without a number the next number of its organization, then makes
the number column required again. Run it with the app stopped, then deploy the previous release.
The database comes from DATABASE_URL. See docs/number-at-issuance-rollback.md.

  --dry-run            Show what would be numbered, change nothing.
  --confirm <name>     Do it. <name> must be the name of the database in DATABASE_URL.`

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const confirmAt = args.indexOf("--confirm")
const confirmation = confirmAt === -1 ? undefined : args[confirmAt + 1]

if (!dryRun && !confirmation) {
  console.error(USAGE)
  process.exit(1)
}

const envFile = discoverWorkspaceEnvFile()
if (envFile) {
  dotenv.config({ path: envFile })
}

const databaseUrl = process.env.DATABASE_URL
const target = resolveDatabaseTarget(databaseUrl)
if (target.kind === "missing" || target.kind === "invalid") {
  console.error(`DATABASE_URL is ${target.kind}. Set it to the database to prepare.`)
  process.exit(1)
}
const databaseName = databaseNameOf(databaseUrl)
if (!dryRun && confirmation !== databaseName) {
  console.error(`Refusing to run: --confirm must be the database name (${databaseName ?? "unknown"}) on ${target.host}, got "${confirmation}".`)
  process.exit(1)
}

// `pg` is a dependency of the app, not of the scripts package.
const { Client } = createRequire(new URL("../apps/oss/package.json", import.meta.url))("pg")
const client = new Client({ connectionString: databaseUrl })
await client.connect()
try {
  console.log(`${dryRun ? "Dry run on" : "Preparing"} database "${databaseName}" on ${target.host}`)
  const result = await prepareNumberRollback(client, { dryRun })
  for (const organization of result.organizations) {
    console.log(`- organization ${organization.organizationId}: ${organization.invoice.length} invoices, ${organization.quote.length} quotes`)
    for (const kind of ["invoice", "quote"]) {
      for (const { id, number } of organization[kind]) console.log(`    ${kind} ${id} -> ${number}`)
    }
  }
  console.log(`${dryRun ? "Would number" : "Numbered"} ${result.invoices} invoices and ${result.quotes} quotes; invoice.number and quote.number ${dryRun ? "would be" : "are"} required again.`)
} catch (error) {
  console.error(`Rollback preparation failed, nothing was changed: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
} finally {
  await client.end()
}
