export type CatalogItemOption = {
  id: string
  name: string
  description: string | null
  defaultUnitPrice: number
}

export type CatalogLineItem = {
  description: string
  quantity: number | string
  unitPrice: number | string
  catalogItemId?: string
}

export function applyCatalogItemToLineItem<Line extends CatalogLineItem>(
  lineItem: Line,
  catalogItemId: string,
  catalogItems: CatalogItemOption[]
): Line {
  const selected = catalogItems.find((item) => item.id === catalogItemId)
  if (!selected) return lineItem

  return {
    ...lineItem,
    catalogItemId,
    description: selected.description?.trim() || selected.name,
    unitPrice: typeof lineItem.unitPrice === "string" ? String(selected.defaultUnitPrice) : selected.defaultUnitPrice,
  }
}
