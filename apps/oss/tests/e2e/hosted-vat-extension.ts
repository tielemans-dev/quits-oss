import { createHmac } from "node:crypto"
import { TRPCError } from "@trpc/server"
import { bootstrapQuitsRuntime } from "../../src/lib/runtime/bootstrap"
import type { SellerVatConfirmationActor, SellerVatConfirmationTransaction } from "../../src/lib/runtime/extensions"
import type { SellerSnapshot } from "@quits/contracts/documents"
import { prisma } from "../../src/lib/db"
import { selfhostRuntimeServices } from "../../src/selfhost/runtime"

// MOCK: OSS contract fixture only, not hosted provider acceptance. No private adapter is copied.
function assertDisposable() {
  if (process.env.QUI62_HOSTED_FIXTURE !== "true" || !process.env.DATABASE_URL ||
      new URL(process.env.DATABASE_URL).pathname !== "/qui62_oss_browser" || process.env.QUITS_DISTRIBUTION !== "cloud") {
    throw new Error("Hosted VAT fixture requires the explicit disposable CI database and cloud distribution")
  }
}
function identity(seller: SellerSnapshot) {
  return JSON.stringify([seller.companyName?.trim(), seller.companyAddress?.trim(), seller.countryCode,
    seller.taxIds?.filter(id => id.scheme?.toLowerCase() === "cvr").map(id => id.value).sort()])
}
const sign = (actor: SellerVatConfirmationActor, seller: SellerSnapshot) => createHmac("sha256", "qui62-synthetic-fixture-only").update(JSON.stringify([actor.organizationId, actor.userId, actor.sessionId, identity(seller)])).digest("hex")
async function admit(db: Pick<SellerVatConfirmationTransaction, "session" | "member">, actor: SellerVatConfirmationActor) {
  const request = actor.request
  if (!request || request.headers.get("origin") !== new URL(request.url).origin || request.headers.has("authorization") || request.headers.has("x-api-key")) throw new TRPCError({ code: "FORBIDDEN" })
  const session = await db.session.findUnique({ where: { id: actor.sessionId } })
  const member = await db.member.findUnique({ where: { organizationId_userId: { organizationId: actor.organizationId, userId: actor.userId } } })
  if (!session || session.userId !== actor.userId || session.activeOrganizationId !== actor.organizationId || session.expiresAt <= new Date() || !member || !["owner", "admin"].includes(member.role)) throw new TRPCError({ code: "FORBIDDEN" })
}
async function table() {
  // A test-only table persists the same evidence across the server and Playwright processes.
  await prisma.$executeRaw`CREATE TABLE IF NOT EXISTS qui62_fixture_confirmation (organization_id text PRIMARY KEY, identity text NOT NULL, status text NOT NULL, user_id text NOT NULL)`
}
export function installHostedVatFixture() {
  assertDisposable()
  bootstrapQuitsRuntime({ services: selfhostRuntimeServices(), extensions: [{
    id: "synthetic-ci-operator",
    resolveCapabilities: () => ({ onboardingV2: { enabled: true, nonVatEnabled: true }, sellerVatConfirmation: { enabled: true } }),
    companyLookup: { async lookup(input) {
      await admit(prisma, input)
      return { unavailable: false, companies: [{ cvr: "24256790", companyName: "Synthetic Seller", companyAddress: "Testvej 1, 1000 København", companyForm: "ApS", statusText: "NORMAL", presetsAllowed: true }] }
    } },
    sellerVatConfirmation: {
      async prepare(input) { await admit(prisma, input); await table(); return { token: sign(input, input.seller) } },
      async confirm(input) {
        await admit(input.tx, input)
        if (input.token !== sign(input, input.seller)) throw new TRPCError({ code: "CONFLICT" })
        if (input.registered === null) await input.tx.$executeRaw`DELETE FROM qui62_fixture_confirmation WHERE organization_id = ${input.organizationId}`
        else await input.tx.$executeRaw`INSERT INTO qui62_fixture_confirmation (organization_id, identity, status, user_id)
          VALUES (${input.organizationId}, ${identity(input.seller)}, ${input.registered ? "registered" : "not_registered"}, ${input.userId})
          ON CONFLICT (organization_id) DO UPDATE SET identity = EXCLUDED.identity, status = EXCLUDED.status, user_id = EXCLUDED.user_id`
      },
    },
    async resolveInvoiceIssuancePolicy(context) {
      await table()
      const rows = await prisma.$queryRaw<Array<{ identity: string; status: "registered" | "not_registered" }>>`SELECT identity, status FROM qui62_fixture_confirmation WHERE organization_id = ${context.organizationId}`
      return { requireSellerVatStatus: true, standardVatRate: "0.25", sellerVatStatus: rows[0]?.identity === identity(context.seller) ? rows[0].status : "unset" }
    },
  }] })
}
