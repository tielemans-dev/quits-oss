# Framework documentation snapshots

`docs/vendor/` contains a selected set of public upstream Markdown and MDX files
for offline reference. It is not a complete documentation site. Follow links on
the upstream site when a referenced page, image or MDX component is absent.

The source URLs, documentation versions, immutable commits and SHA-256 hashes
are recorded in [vendor-sources.json](vendor-sources.json). TanStack, Better Auth
and tRPC snapshots match the packages resolved in `bun.lock`. Prisma's separate
documentation repository has no matching package tag; its snapshot uses the
explicit previous-major documentation and upgrade guide for the app's locked
Prisma dependency. It does not vendor the next major's client documentation.

The snapshots preserve upstream bytes and available license files. Prisma's
documentation repository declares no license file at the recorded revision;
these files retain their upstream ownership, not Quits' repository license.

Verify checksums offline from the repository root:

```sh
node scripts/vendor-docs.mjs --check
```

Restore the recorded snapshots using only unauthenticated public URLs:

```sh
node scripts/vendor-docs.mjs --fetch
```

To update, select public upstream docs for the dependency versions in `bun.lock`,
record their full commit SHAs, source URLs and new hashes in the manifest, then
fetch and verify. Keep the selection below the script's 128 KiB limit. Include
upstream license files when provided. Do not copy application code, assets,
private sources or whole repositories.

Oxlint and the docs-version checker exclude the snapshot tree. GitHub marks it
as generated and vendored, so reviews cover the manifest, updater and exclusions
instead of upstream prose. Git preserves upstream whitespace without local checks.
Consult the snapshots when needed for implementation; do not apply repository
copy or style rules to their contents.
