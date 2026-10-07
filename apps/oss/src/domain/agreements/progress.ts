export function deliverableProgress(lines: ReadonlyArray<{ status: string; isDeposit: boolean }>) {
  const work = lines.filter((line) => !line.isDeposit)
  const count = (status: string) => work.filter((line) => line.status === status).length
  return {
    planned: count("planned"),
    in_progress: count("in_progress"),
    delivered: count("delivered"),
    accepted: count("accepted"),
    changes_requested: count("changes_requested"),
    cancelled: count("cancelled"),
    deposits: lines.filter((line) => line.isDeposit).length,
  }
}
