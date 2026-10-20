/** One party of a public document, as its PDF shows it: a heading over the party's lines. */
export function PartyBlock({ title, lines }: { title: string; lines: Array<string | null | undefined> }) {
  return (
    <div>
      <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h2>
      {lines.filter(Boolean).map((line, index) => <p key={index}>{line}</p>)}
    </div>
  )
}
