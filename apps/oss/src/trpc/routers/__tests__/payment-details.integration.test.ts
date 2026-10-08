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

const complete = {
  accountHolder: "Nordic Design ApS",
  bankName: "Danske Bank",
  regNumber: "0040",
  accountNumber: "0440116243",
  iban: "DK5000400440116243",
  bic: "DABADKKK",
  note: "MobilePay Box 12345",
}

const empty = {
  accountHolder: null,
  bankName: null,
  regNumber: null,
  accountNumber: null,
  iban: null,
  bic: null,
  note: null,
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
    expect(await admin.paymentDetails.get()).toEqual({ details: empty, canUpdate: true })

    expect(await admin.paymentDetails.update(complete)).toEqual({ details: complete, canUpdate: true })
    expect(await admin.paymentDetails.get()).toEqual({ details: complete, canUpdate: true })

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
        accountHolder: "  Nordic Design ApS  ",
        bankName: "",
        regNumber: " 0040 ",
        accountNumber: "0440 116243",
        iban: "dk50 0040 0440 1162 43",
        bic: " dabadkkk ",
        note: "   ",
      })
    ).toEqual({
      details: {
        ...empty,
        accountHolder: "Nordic Design ApS",
        regNumber: "0040",
        accountNumber: "0440116243",
        iban: "DK5000400440116243",
        bic: "DABADKKK",
      },
      canUpdate: true,
    })
  })

  it("replaces all details, so a field left out is cleared", async () => {
    const { admin } = await organization()
    await admin.paymentDetails.update(complete)
    expect(await admin.paymentDetails.update({ iban: "DK5000400440116243" })).toEqual({
      details: { ...empty, iban: "DK5000400440116243" },
      canUpdate: true,
    })
    expect((await admin.paymentDetails.get()).details).toEqual({ ...empty, iban: "DK5000400440116243" })
    expect((await admin.paymentDetails.update({})).details).toEqual(empty)
  })

  it("creates the settings row when the organization has none yet", async () => {
    const { org, admin } = await organization()
    await prisma.orgSettings.delete({ where: { organizationId: org.organizationId } })
    expect((await admin.paymentDetails.get()).details).toEqual(empty)
    expect((await admin.paymentDetails.update({ note: "Pay by transfer" })).details).toEqual({
      ...empty,
      note: "Pay by transfer",
    })
  })

  it.each([
    ["a corrupted IBAN", { iban: "DK5000400440116244" }],
    ["a malformed BIC", { bic: "DABADKK" }],
    ["a reg.nr. without account number", { regNumber: "0040" }],
    ["an account number without reg.nr.", { accountNumber: "0440116243" }],
    ["a reg.nr. that is not four digits", { regNumber: "004", accountNumber: "0440116243" }],
    ["an account number longer than ten digits", { regNumber: "0040", accountNumber: "12345678901" }],
    ["a payment note over 500 characters", { note: "x".repeat(501) }],
  ])("rejects %s and keeps what was saved", async (_name, input) => {
    const { admin } = await organization()
    await admin.paymentDetails.update(complete)
    await expect(admin.paymentDetails.update(input)).rejects.toMatchObject({ code: "BAD_REQUEST" })
    expect((await admin.paymentDetails.get()).details).toEqual(complete)
  })

  it("lets members and accountants read the details but not change them", async () => {
    const { admin, member, accountant } = await organization()
    await admin.paymentDetails.update(complete)

    expect(await member.paymentDetails.get()).toEqual({ details: complete, canUpdate: false })
    expect(await accountant.paymentDetails.get()).toEqual({ details: complete, canUpdate: false })
    await expect(member.paymentDetails.update({ iban: "DK5000400440116243" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(accountant.paymentDetails.update({})).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect((await admin.paymentDetails.get()).details).toEqual(complete)
  })

  it("keeps each organization's details to itself", async () => {
    const first = await organization()
    const second = await organization()
    await first.admin.paymentDetails.update(complete)
    expect((await second.admin.paymentDetails.get()).details).toEqual(empty)
  })

  it("requires a signed-in user", async () => {
    const anonymous = appRouter.createCaller({ session: null } as never)
    await expect(anonymous.paymentDetails.get()).rejects.toMatchObject({ code: "UNAUTHORIZED" })
    await expect(anonymous.paymentDetails.update({})).rejects.toMatchObject({ code: "UNAUTHORIZED" })
  })
})
