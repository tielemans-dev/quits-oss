const MAX_SLUG_LENGTH = 48

/** URL-safe organization slug: lowercase ASCII, digits, and single hyphens. */
export function isOrganizationSlug(value: string): boolean {
  return value.length > 0 && value.length <= MAX_SLUG_LENGTH && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}

/** Builds a URL-safe slug from a company name. Danish vowels fold to ASCII. */
export function organizationSlugFromName(name: string): string {
  const folded = name
    .trim()
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/ø/g, "oe")
    .replace(/å/g, "aa")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "")
  return isOrganizationSlug(folded) ? folded : "organization"
}

/** First slug is the name; later ones add a numeric suffix so a taken slug can be retried. */
export function organizationSlugCandidates(name: string, limit = 12): string[] {
  const base = organizationSlugFromName(name)
  const candidates: string[] = []
  for (let index = 0; candidates.length < limit; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`
    const head = base.slice(0, Math.max(1, MAX_SLUG_LENGTH - suffix.length)).replace(/-+$/g, "") || "organization"
    const candidate = `${head}${suffix}`
    if (isOrganizationSlug(candidate) && !candidates.includes(candidate)) candidates.push(candidate)
  }
  return candidates
}

export async function createNamedOrganization(input: {
  name: string
  isSlugAvailable: (slug: string) => Promise<boolean>
  create: (body: { name: string; slug: string }) => Promise<{ ok: true; id: string } | { ok: false; message: string }>
}): Promise<{ ok: true; id: string; slug: string } | { ok: false; message: string }> {
  const name = input.name.trim()
  if (!name) return { ok: false, message: "missing" }
  let sawTaken = false
  for (const slug of organizationSlugCandidates(name)) {
    if (!(await input.isSlugAvailable(slug))) {
      sawTaken = true
      continue
    }
    const created = await input.create({ name, slug })
    if (created.ok) return { ok: true, id: created.id, slug }
    if (/already exists|slug already taken/i.test(created.message)) {
      sawTaken = true
      continue
    }
    return created
  }
  return { ok: false, message: sawTaken ? "taken" : "missing" }
}
