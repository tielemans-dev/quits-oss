/** The delivery revision's review window, independent of the client page's own expiry. */
export function deliveryReviewExpiresAt(deliveredAt: Date | null) {
  return deliveredAt ? new Date(deliveredAt.getTime() + 90 * 86_400_000) : null
}

/** Completed decisions stay completed, including replay after the review window closes. */
export function deliveryReviewState(
  line: { status: string; deliveredAt: Date | null },
  now: Date,
): "awaiting" | "accepted" | "changes_requested" | "expired" | "unavailable" {
  if (line.status === "accepted" || line.status === "changes_requested") return line.status
  const expiresAt = deliveryReviewExpiresAt(line.deliveredAt)
  if (!expiresAt) return "unavailable"
  return now < expiresAt ? "awaiting" : "expired"
}
