/**
 * The kind of record an item of the client action page stands for, including one that can no
 * longer be shown. Kept apart from the page builder, which reads the database: the page's
 * components run in the browser and import only this.
 */
export function itemRecordKind(item: { kind: "agreement" | "deliverable" | "invoice" } | { kind: "inactive"; recordKind: "agreement" | "deliverable" | "invoice" }) {
  return item.kind === "inactive" ? item.recordKind : item.kind
}
