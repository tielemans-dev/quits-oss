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
function* iterateOrganizationSlugs(name: string): Generator<string> {
  const base = organizationSlugFromName(name)
  for (let index = 1n; ; index += 1n) {
    const suffix = index === 1n ? "" : `-${index}`
    const head = base.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/g, "") || "organization"
    yield `${head}${suffix}`
  }
}

export function organizationSlugCandidates(name: string, limit = 12): string[] {
  const candidates: string[] = []
  for (const candidate of iterateOrganizationSlugs(name)) {
    if (candidates.length >= limit) break
    candidates.push(candidate)
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
  const candidates = iterateOrganizationSlugs(name)
  for (;;) {
    const slug = candidates.next().value as string
    if (!(await input.isSlugAvailable(slug))) {
      continue
    }
    const created = await input.create({ name, slug })
    if (created.ok) return { ok: true, id: created.id, slug }
    if (/already exists|slug already taken/i.test(created.message)) {
      continue
    }
    return created
  }
}
