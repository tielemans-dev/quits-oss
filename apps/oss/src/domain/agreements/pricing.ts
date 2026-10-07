import type { DeliverableInput } from "@quits/contracts/agreements"
import { priceDocument } from "../documents/pricing"

/** Agreements have one nominal tax rate; operational fields never affect the price. */
export function priceAgreement(
  input: Omit<Parameters<typeof priceDocument>[0], "items"> & { deliverables: DeliverableInput[] },
) {
  const priced = priceDocument({
    ...input,
    items: input.deliverables.map((line) => ({
      description: line.description ?? "",
      quantity: line.quantity,
      unitPrice: line.unitPrice,
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
        title: line.title,
        agreedDate: line.agreedDate ? new Date(line.agreedDate) : null,
        expectedDate: line.expectedDate ? new Date(line.expectedDate) : null,
        isDeposit: line.isDeposit ?? false,
      }
    }),
  }
}
