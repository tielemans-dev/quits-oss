/** Saves generated text as a file in the browser. */
export function downloadTextFile(filename: string, content: string, mimeType: string) {
  // A byte-order mark lets spreadsheet apps detect UTF-8 in CSV files.
  const body = mimeType.startsWith("text/csv") ? `\uFEFF${content}` : content
  const url = URL.createObjectURL(new Blob([body], { type: mimeType }))
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
