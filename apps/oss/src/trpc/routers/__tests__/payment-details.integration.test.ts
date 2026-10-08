import { afterEach, describe, expect, it } from "vitest"
import { prisma } from "../../../lib/db"
import { createTestOrganization, hasTestDatabase } from "../../../test-utils/organization"
import { appRouter } from "../../router"

const describeIfDatabase = hasTestDatabase ? describe : describe.skip

function callerFor(organizationId: string, userId: string) {
  return appRouter.createCaller({
    session: {
      user: { id: userId, email: `${userId}@test.quits.invalid`, name: userId },
      session: { activeOrganizationId: organizationId },
    },
  } as never)
}

const account = {
  accountHolder: "Nordic Design ApS",
  bankName: "Danske Bank",
  regNumber: "0040",
  accountNumber: "0440116243",
  iban: "DK5000400440116243",
  bic: "DABADKKK",
}
const complete = { bankAccount: account, note: "MobilePay Box 12345" }
const empty = { bankAccount: null, note: null }
const emptyAccount = {
  accountHolder: null,
  bankName: null,
  regNumber: null,
  accountNumber: null,
  iban: null,
  bic: null,
}

describeIfDatabase("paymentDetails router", () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  async function organization() {
    const org = await createTestOrganization({ roles: ["admin", "member", "accountant"] })
    cleanups.push(org.cleanup)
    return {
      org,
      admin: callerFor(org.organizationId, org.actors.admin.userId),
      member: callerFor(org.organizationId, org.actors.member.userId),
      accountant: callerFor(org.organizationId, org.actors.accountant.userId),
    }
  }

  it("starts empty and stores what an admin saves", async () => {
    const { org, admin } = await organization()
    expect(await admin.paymentDetails.get()).toEqual({ ...empty, canUpdate: true })

    expect(await admin.paymentDetails.update(complete)).toEqual({ ...complete, canUpdate: true })
    expect(await admin.paymentDetails.get()).toEqual({ ...complete, canUpdate: true })

    expect(
      await prisma.orgSettings.findUniqueOrThrow({
        where: { organizationId: org.organizationId },
        select: {
          bankAccountHolder: true,
          bankName: true,
          bankRegNumber: true,
          bankAccountNumber: true,
          bankIban: true,
          bankBic: true,
          paymentNote: true,
        },
      })
    ).toEqual({
      bankAccountHolder: "Nordic Design ApS",
      bankName: "Danske Bank",
      bankRegNumber: "0040",
      bankAccountNumber: "0440116243",
      bankIban: "DK5000400440116243",
      bankBic: "DABADKKK",
      paymentNote: "MobilePay Box 12345",
    })
  })

  it("normalizes input and turns empty values into null", async () => {
    const { admin } = await organization()
    expect(
      await admin.paymentDetails.update({
        bankAccount: {
          accountHolder: "  Nordic Design ApS  ",
          bankName: "",
          regNumber: " 0040 ",
          accountNumber: "0440 116243",
          iban: "dk50 0040 0440 1162 43",
          bic: " dabadkkk ",
        },
        note: "   ",
      })
    ).toEqual({
      bankAccount: { ...account, bankName: null },
      note: null,
      canUpdate: true,
    })
  })

  it("replaces all details, so a part left out is cleared", async () => {
    const { admin } = await organization()
    await admin.paymentDetails.update(complete)
    const ibanOnly = { bankAccount: { ...emptyAccount, iban: "DK5000400440116243" }, note: null }
    expect(await admin.paymentDetails.update({ bankAccount: { iban: "DK5000400440116243" } })).toEqual({
      ...ibanOnly,
      canUpdate: true,
    })
    const { canUpdate: _, ...saved } = await admin.paymentDetails.get()
    expect(saved).toEqual(ibanOnly)
    const { canUpdate: __, ...cleared } = await admin.paymentDetails.update({})
    expect(cleared).toEqual(empty)
  })

  it("treats a blank account like no account and keeps the note", async () => {
    const { admin } = await organization()
    await admin.paymentDetails.update(complete)
    const { canUpdate: _, ...saved } = await admin.paymentDetails.update({
      bankAccount: { accountHolder: " ", iban: "" },
      note: "Pay by transfer",
    })
    expect(saved).toEqual({ bankAccount: null, note: "Pay by transfer" })
  })

  it("creates the settings row when the organization has none yet", async () => {
    const { org, admin } = await organization()
    await prisma.orgSettings.delete({ where: { organizationId: org.organizationId } })
    expect(await admin.paymentDetails.get()).toMatchObject(empty)
    expect(await admin.paymentDetails.update({ note: "Pay by transfer" })).toMatchObject({
      bankAccount: null,
      note: "Pay by transfer",
    })
  })

  it.each([
    ["a corrupted IBAN", { bankAccount: { iban: "DK5000400440116244" } }],
    ["a DK IBAN with one digit too many", { bankAccount: { iban: "DK50004004401162430" } }],
    ["a malformed BIC", { bankAccount: { iban: "DK5000400440116243", bic: "DABADKK" } }],
    ["a reg.nr. without account number", { bankAccount: { regNumber: "0040" } }],
    ["an account number without reg.nr.", { bankAccount: { accountNumber: "0440116243" } }],
    ["a reg.nr. that is not four digits", { bankAccount: { regNumber: "004", accountNumber: "0440116243" } }],
    ["an account number longer than ten digits", { bankAccount: { regNumber: "0040", accountNumber: "12345678901" } }],
    ["a bank name without anything to pay to", { bankAccount: { bankName: "Danske Bank" } }],
    ["a payment note over 500 characters", { note: "x".repeat(501) }],
  ])("rejects %s and keeps what was saved", async (_name, input) => {
    const { admin } = await organization()
    await admin.paymentDetails.update(complete)
    await expect(admin.paymentDetails.update(input)).rejects.toMatchObject({ code: "BAD_REQUEST" })
    expect(await admin.paymentDetails.get()).toEqual({ ...complete, canUpdate: true })
  })

  it("lets members and accountants read the details but not change them", async () => {
    const { admin, member, accountant } = await organization()
    await admin.paymentDetails.update(complete)

    expect(await member.paymentDetails.get()).toEqual({ ...complete, canUpdate: false })
    expect(await accountant.paymentDetails.get()).toEqual({ ...complete, canUpdate: false })
    await expect(member.paymentDetails.update({ bankAccount: { iban: "DK5000400440116243" } })).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(accountant.paymentDetails.update({})).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(await admin.paymentDetails.get()).toEqual({ ...complete, canUpdate: true })
  })

  it("keeps each organization's details to itself", async () => {
    const first = await organization()
    const second = await organization()
    await first.admin.paymentDetails.update(complete)
    expect(await second.admin.paymentDetails.get()).toEqual({ ...empty, canUpdate: true })
  })

  it("requires a signed-in user", async () => {
    const anonymous = appRouter.createCaller({ session: null } as never)
    await expect(anonymous.paymentDetails.get()).rejects.toMatchObject({ code: "UNAUTHORIZED" })
    await expect(anonymous.paymentDetails.update({})).rejects.toMatchObject({ code: "UNAUTHORIZED" })
  })
})
