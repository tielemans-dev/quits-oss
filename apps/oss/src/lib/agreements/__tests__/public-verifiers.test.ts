import { describe, expect, it } from "vitest"
import { signAgreementPublicToken, verifyAgreementPublicToken } from "../tokens"
import { signQuotePublicToken, verifyQuotePublicToken } from "../../quotes/public"
import { signInvoicePaymentToken, verifyInvoicePaymentToken } from "../../payments/public"
const secret = "synthetic-public-token-secret"
describe("canonical public token framing", () => {
  const cases = [
    {
      name: "agreement",
      token: signAgreementPublicToken(
        {
          agreementId: "agreement",
          scope: "decide",
          keyVersion: 1,
          offerRevision: 1,
          exp: "2027-01-01T00:00:00.000Z",
        },
        secret,
      ),
      verify: verifyAgreementPublicToken,
    },
    {
      name: "quote",
      token: signQuotePublicToken(
        { quoteId: "quote", keyVersion: 1, scope: "quote_public" },
        secret,
      ),
      verify: verifyQuotePublicToken,
    },
    {
      name: "pay",
      token: signInvoicePaymentToken(
        { invoiceId: "invoice", keyVersion: 1, scope: "invoice_payment" },
        secret,
      ),
      verify: verifyInvoicePaymentToken,
    },
  ]
  for (const { name, token, verify } of cases) {
    it(`${name} accepts its existing two components and rejects every extra component`, () => {
      expect(verify(token, secret)).not.toBeNull()
      expect(verify(token, "wrong-secret")).toBeNull()
      for (const suffix of [".", ".suffix", ".suffix.more", "..", ".\n"])
        expect(verify(token + suffix, secret)).toBeNull()
      expect(verify(token.split(".")[0]!, secret)).toBeNull()
    })
  }
})
