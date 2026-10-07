import type { DeliverableInput } from "@quits/contracts/agreements"
import { priceDocument, priceDocumentV2 } from "../documents/pricing"

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

/** v2 prices services and the payment schedule independently; deposits never inflate scope. */
export function priceAgreementV2(input: Parameters<typeof priceAgreement>[0]) {
  const sources = input.deliverables.map((line) => ({
    description: line.description || line.title,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    vat: line.vat,
  }))
  const services = priceDocumentV2({ ...input, items: sources.filter((_, i) => !input.deliverables[i]!.isDeposit) })
  const schedule = priceDocumentV2({ ...input, items: sources.filter((_, i) => input.deliverables[i]!.isDeposit) })
  let serviceIndex = 0, scheduleIndex = 0
  return {
    subtotalNet: services.subtotalNet,
    totalTax: services.totalTax,
    totalGross: services.totalGross,
    calculationVersion: "v2" as const,
    deliverableRows: input.deliverables.map((line, sortOrder) => ({
      ...(line.isDeposit ? schedule.itemRows[scheduleIndex++]! : services.itemRows[serviceIndex++]!),
      description: line.description ?? "",
      title: line.title, sortOrder,
      agreedDate: line.agreedDate ? new Date(line.agreedDate) : null,
      expectedDate: line.expectedDate ? new Date(line.expectedDate) : null,
      isDeposit: line.isDeposit ?? false,
    })),
  }
}
