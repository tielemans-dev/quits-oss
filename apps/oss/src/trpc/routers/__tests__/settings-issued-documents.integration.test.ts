import "dotenv/config"
import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import { Prisma } from "../../../../generated/prisma/client"
import { hasIssuedDocuments } from "../../../domain/documents/base-currency"
import { prisma } from "../../../lib/db"
import { ensureTestMembership } from "../../../test-utils/membership"
import { cleanupTestOrganizations } from "../../../test-utils/organization"
import { appRouter } from "../../router"

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const createdOrganizationIds: string[] = []

/** An organization with membership and a contact, but no settings row and no documents. */
async function createOrganization() {
  const organizationId = randomUUID()
  const userId = `issued-docs-${organizationId.slice(0, 8)}`
  createdOrganizationIds.push(organizationId)
  await prisma.organization.create({
    data: {
      id: organizationId,
      name: "Issued Documents Org",
      slug: `issued-docs-${organizationId}`,
      createdAt: new Date(),
      subscriptionStatus: "pro",
    },
  })
  await ensureTestMembership(organizationId, userId)
  const contact = await prisma.contact.create({
    data: { organizationId, name: "Buyer", email: "buyer@example.com", country: "DK" },
  })
  const caller = appRouter.createCaller({
    session: {
      user: { id: userId, email: `${userId}@example.com`, name: "Issued Documents User" },
      session: { activeOrganizationId: organizationId },
    },
  } as never)
  return { organizationId, contactId: contact.id, caller }
}

const money = { subtotalNet: new Prisma.Decimal(100), totalGross: new Prisma.Decimal(125) }

function invoiceData(organizationId: string, contactId: string, overrides: Partial<Prisma.InvoiceUncheckedCreateInput> = {}) {
  return {
    organizationId,
    contactId,
    number: `INV-${randomUUID().slice(0, 8)}`,
    dueDate: new Date("2026-11-01T00:00:00.000Z"),
    ...money,
    ...overrides,
  } satisfies Prisma.InvoiceUncheckedCreateInput
}

async function createIssuanceCandidate(organizationId: string, status: string) {
  const documentId = randomUUID()
  const staging = await prisma.artifactStaging.create({
    data: {
      organizationId,
      documentKind: "invoice",
      documentId,
      requestKey: randomUUID(),
      renderInputHash: randomUUID(),
      renderInput: {},
      rendererVersion: "test",
      leaseUntil: new Date(),
    },
  })
  return prisma.issuanceCandidate.create({
    data: {
      organizationId,
      documentKind: "invoice",
      documentId,
      stagingId: staging.id,
      renderInput: {},
      renderInputHash: staging.renderInputHash,
      attemptAt: new Date(),
      status,
    },
  })
}

/** Rows that look like documents but must not lock the base currency. */
async function createUnissuedDocuments(organizationId: string, contactId: string) {
  await prisma.invoice.create({ data: invoiceData(organizationId, contactId, { status: "draft" }) })
  await prisma.quote.create({
    data: {
      organizationId,
      contactId,
      number: `QTE-${randomUUID().slice(0, 8)}`,
      status: "draft",
      expiryDate: new Date("2026-11-01T00:00:00.000Z"),
      ...money,
    },
  })
  await prisma.agreement.create({
    data: {
      organizationId,
      contactId,
      title: "Unissued agreement",
      termsMarkdown: "Terms",
      validUntil: new Date("2026-11-01T00:00:00.000Z"),
      ...money,
    },
  })
  await prisma.domainEvent.create({
    data: {
      organizationId,
      sequence: 1,
      aggregateType: "invoice",
      aggregateId: randomUUID(),
      type: "invoice.draft_created",
      payload: {},
      actorKind: "user",
    },
  })
  await createIssuanceCandidate(organizationId, "pending")
}

type IssuedCase = { name: string; create: (organizationId: string, contactId: string) => Promise<unknown> }

const issuedCases: IssuedCase[] = [
  {
    name: "a non-draft invoice",
    create: (organizationId, contactId) =>
      prisma.invoice.create({ data: invoiceData(organizationId, contactId, { status: "sent" }) }),
  },
  {
    name: "a credit note",
    create: async (organizationId, contactId) => {
      const invoice = await prisma.invoice.create({ data: invoiceData(organizationId, contactId, { status: "draft" }) })
      return prisma.creditNote.create({
        data: {
          organizationId,
          invoiceId: invoice.id,
          contactId,
          number: `CN-${randomUUID().slice(0, 8)}`,
          reason: "Correction",
          currency: "DKK",
          countryCode: "DK",
          locale: "da-DK",
          timezone: "Europe/Copenhagen",
          taxRegime: "eu_vat",
          ...money,
        },
      })
    },
  },
  {
    name: "a non-draft quote",
    create: (organizationId, contactId) =>
      prisma.quote.create({
        data: {
          organizationId,
          contactId,
          number: `QTE-${randomUUID().slice(0, 8)}`,
          status: "sent",
          expiryDate: new Date("2026-11-01T00:00:00.000Z"),
          ...money,
        },
      }),
  },
  {
    name: "an agreement with an offer snapshot",
    create: (organizationId, contactId) =>
      prisma.agreement.create({
        data: {
          organizationId,
          contactId,
          title: "Offered agreement",
          termsMarkdown: "Terms",
          validUntil: new Date("2026-11-01T00:00:00.000Z"),
          offerSnapshot: { title: "Offered agreement" },
          ...money,
        },
      }),
  },
  ...["invoice.issued", "invoice.sent", "credit_note.issued", "quote.sent", "agreement.offer_issued"].map(
    (type): IssuedCase => ({
      name: `a ${type} event`,
      create: (organizationId) =>
        prisma.domainEvent.create({
          data: {
            organizationId,
            sequence: 2,
            aggregateType: type.split(".")[0] ?? "invoice",
            aggregateId: randomUUID(),
            type,
            payload: {},
            actorKind: "user",
          },
        }),
    })
  ),
  {
    name: "a bound issuance candidate",
    create: (organizationId) => createIssuanceCandidate(organizationId, "bound"),
  },
]

describeIfDatabase("settings issued-document lock and first read", () => {
  afterAll(async () => {
    await cleanupTestOrganizations({ where: { id: { in: createdOrganizationIds } } })
  })

  it("does not lock the base currency for drafts, unrelated events or unbound candidates", async () => {
    const { organizationId, contactId, caller } = await createOrganization()
    expect(await hasIssuedDocuments(prisma, organizationId)).toBe(false)

    await createUnissuedDocuments(organizationId, contactId)
    expect(await hasIssuedDocuments(prisma, organizationId)).toBe(false)
    expect(await prisma.$transaction((tx) => hasIssuedDocuments(tx, organizationId))).toBe(false)
    expect((await caller.settings.get()).baseCurrencyLocked).toBe(false)
  })

  it.each(issuedCases)("locks the base currency after $name", async ({ create }) => {
    const { organizationId, contactId, caller } = await createOrganization()
    await createUnissuedDocuments(organizationId, contactId)
    await create(organizationId, contactId)

    expect(await hasIssuedDocuments(prisma, organizationId)).toBe(true)
    expect(await prisma.$transaction((tx) => hasIssuedDocuments(tx, organizationId))).toBe(true)
    expect((await caller.settings.get()).baseCurrencyLocked).toBe(true)
  })

  it("ignores documents issued by another organization", async () => {
    const other = await createOrganization()
    await prisma.invoice.create({ data: invoiceData(other.organizationId, other.contactId, { status: "sent" }) })
    const { organizationId } = await createOrganization()

    expect(await hasIssuedDocuments(prisma, organizationId)).toBe(false)
  })

  it("creates one settings row when first reads race", async () => {
    const { organizationId, caller } = await createOrganization()

    const reads = await Promise.all(Array.from({ length: 5 }, () => caller.settings.get()))

    expect(new Set(reads.map((read) => read.id)).size).toBe(1)
    expect(await prisma.orgSettings.count({ where: { organizationId } })).toBe(1)
  })
})

describeIfDatabase("invoices.list response", () => {
  afterAll(async () => {
    await cleanupTestOrganizations({ where: { id: { in: createdOrganizationIds } } })
  })

  it("returns every invoice column plus the derived fields, newest first with id breaking ties", async () => {
    const { organizationId, contactId, caller } = await createOrganization()
    const createdAt = new Date("2026-10-01T12:00:00.000Z")
    await prisma.invoice.create({ data: invoiceData(organizationId, contactId, { id: `inv-a-${organizationId}`, createdAt }) })
    await prisma.invoice.create({ data: invoiceData(organizationId, contactId, { id: `inv-b-${organizationId}`, createdAt }) })
    await prisma.invoice.create({
      data: invoiceData(organizationId, contactId, { id: `inv-c-${organizationId}`, createdAt: new Date("2026-09-01T12:00:00.000Z") }),
    })

    const invoices = await caller.invoices.list()

    expect(invoices.map((invoice) => invoice.id)).toEqual([
      `inv-b-${organizationId}`,
      `inv-a-${organizationId}`,
      `inv-c-${organizationId}`,
    ])
    // The response is unchanged from before the query work: every invoice column, the contact
    // name and the derived amounts and payment link.
    const [first] = invoices
    expect(Object.keys(first ?? {}).sort()).toEqual(
      [
        ...Object.values(Prisma.InvoiceScalarFieldEnum),
        "contact",
        "subtotal",
        "taxAmount",
        "total",
        "balanceDue",
        "publicPaymentUrl",
      ].sort()
    )
    expect(first).toMatchObject({
      status: "draft",
      currency: expect.any(String),
      organizationId,
      contactId,
      contact: { name: "Buyer" },
      subtotal: 100,
      total: 125,
      balanceDue: 125,
    })
    expect(first?.issueDate).toBeInstanceOf(Date)
    expect(first?.dueDate).toBeInstanceOf(Date)
  })
})
