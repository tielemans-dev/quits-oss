import type { DeliverableInput } from "@quits/contracts/agreements"
import { priceDocument } from "../documents/pricing"

/** Agreements have one nominal tax rate; operational fields never affect the price. */
export function priceAgreement(
  input: Omit<Parameters<typeof priceDocument>[0], "items" | "taxRate"> & { deliverables: DeliverableInput[]; taxRate: number | string },
) {
  const priced = priceDocument({
    ...input,
    taxRate: Number(input.taxRate),
    items: input.deliverables.map((line) => ({
      description: line.description ?? "",
      quantity: Number(line.quantity),
      unitPrice: Number(line.unitPrice),
    })),
  })
  return {
    subtotalNet: priced.subtotalNet,
    totalTax: priced.totalTax,
    totalGross: priced.totalGross,
    deliverableRows: priced.itemRows.map((row, index) => {
      const line = input.deliverables[index]!
      return {
        ...row,
        quantityInput: String(line.quantity),
        unitPriceInput: String(line.unitPrice),
        inputPrecision: typeof line.quantity === "number" || typeof line.unitPrice === "number" ? "number" : "string",
        title: line.title,
        agreedDate: line.agreedDate ? new Date(line.agreedDate) : null,
        expectedDate: line.expectedDate ? new Date(line.expectedDate) : null,
        isDeposit: line.isDeposit ?? false,
      }
    }),
  }
}
