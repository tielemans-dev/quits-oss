/** Browser downloads use the authorized server route, including for live drafts. */
export async function downloadDocumentPdf(kind: "invoice" | "creditNote", id: string, number: string) {
  const response = await fetch(`/api/documents/${kind}/${encodeURIComponent(id)}/pdf`)
  if (!response.ok) throw new Error(await response.text())
  const url = URL.createObjectURL(await response.blob())
  const a = document.createElement("a")
  a.href = url
  a.download = `${number}.pdf`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
