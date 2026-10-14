# PostgreSQL image acquisition in CI

QUI-109 changes every OSS CI PostgreSQL acquisition to the proposed owned mirror
`ghcr.io/tielemans-dev/ci-postgres`. The tag and immutable index digest stay unchanged.
Anonymous ECR Public pulls returned `toomanyrequests: Data limit exceeded`, including
service initialization before checkout. Retries cannot remove that quota dependency.

Service containers authenticate before checkout through `services.postgres.credentials`.
Explicit pulls log in with a temporary Docker config, then delete it on exit. Both use the
job's built-in `GITHUB_TOKEN` with `packages: read` and `contents: read`. No stored registry
credential, publishing permission, paid service, or application dependency is added.
The shared browser harness still receives a local `postgres:16-alpine` tag from the pinned
image and checks image ID equality and PostgreSQL 16.15 before running its scenarios.

## External prerequisite and Kai handoff

The mirror is a proposed destination, not a verified existing package. GitHub denied secret
and variable metadata access with HTTP 403; package enumeration did not establish a mirror.
No image has been published and no credentials or secrets have been changed by this PR.
Do not merge until Kai completes the following provisioning plan and one PR CI run is green.

1. Approve the destination and copy the complete upstream multi-platform index, child
   manifests and blobs to GHCR without rebuilding or changing media types. For example,
   an administrator with existing authorized registry tools can use
   `skopeo copy --all --preserve-digests docker://SOURCE docker://DESTINATION`.
   Substitute the exact references below. Stop if the tool cannot preserve the digest.
2. Make the package public for this public repository and fork contributions. Connect it
   to `tielemans-dev/quits-oss`, and grant that repository Actions read access. Test that
   its `GITHUB_TOKEN` can read it with `packages: read`, including a fork PR context.
   Do not add a PAT to PR workflows or use `pull_request_target` to obtain credentials.
3. Retrieve the raw source and destination indexes. Compare their exact registry bytes and
   SHA-256 hashes with the pinned index. Also verify the recorded linux/amd64 manifest.
   Record the copy tool/version, operator, time, index and child-manifest evidence in this doc.
4. Run this draft PR's CI after provisioning. Require successful authenticated service pulls
   in unit, runtime and OSS boundary, and the shared browser's authenticated pull/version
   checks. Require green `verify`, `verify-oss-boundary`, `ci-ok` and
   `Shared product browser scenarios`. A static fixture pass is not registry or CI proof.

Source reference:
`public.ecr.aws/docker/library/postgres:16.15-alpine3.24@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea`

Proposed destination reference:
`ghcr.io/tielemans-dev/ci-postgres:16.15-alpine3.24@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea`

GitHub documents [package access for Actions](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility)
and [free storage/bandwidth for public packages](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-packages/about-billing-for-github-packages).
This removes the upstream anonymous quota from CI after provisioning. It does not guarantee
GHCR availability. Missing images, denied authentication or failed pulls still fail jobs.
There is no anonymous fallback or different digest. Until provisioned, CI is expected to fail.

## Provenance and pin

The following source evidence predates QUI-109. It does not certify the proposed GHCR copy.

- [AWS documents Docker Official Images on ECR Public](https://aws.amazon.com/blogs/containers/docker-official-images-now-available-on-amazon-elastic-container-registry-public/).
- Registry namespace: `public.ecr.aws/docker/library/postgres`.
- Version tag: `16.15-alpine3.24`, the version behind `16-alpine` when checked on 2026-10-09.
- Multi-platform index: `sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea`.
- Linux amd64 manifest: `sha256:1a66d744c1b459e13b05a8fca341da84cb63383e99ce262210efee5a319d4551`.
- Manifest annotations identify `16.15-alpine3.24`, base `alpine:3.24`, and source
  `https://github.com/docker-library/postgres.git#9d15534160ade17f2b6c455a39ee967c49b1937d:16/alpine3.24`.
- [Official Images source metadata](https://github.com/docker-library/official-images/blob/master/library/postgres)
  assigned these tags to that source revision at verification time.

The ECR and Docker Hub raw `16-alpine` indexes matched byte for byte after removing the command's
trailing newline, and hashed to the pinned digest. Local execution reported PostgreSQL 16.15 and
Alpine 3.24.2. A disposable fixture verified committed rows and rollback. Browser preparation checks
local image ID equality and the exact PostgreSQL version before the shared runner starts.

## Updating

Keep all five PostgreSQL-consuming OSS workflows in sync. Before changing the pin, verify
Official Images source metadata and raw upstream indexes, then repeat the approved complete
copy with digest preservation. Verify destination index and platform hashes, PostgreSQL and
Alpine versions, disposable database fixtures and required CI checks. Keep the version tag
and immutable digest; never resolve a moving tag during CI or fall back on acquisition failure.

The current required-job graph, documentation classifier and failure propagation remain intact.
Run `ruby scripts/__tests__/ci-paths.test.rb` and `node --test .github/scripts/ci-gate.test.mjs`
for lightweight workflow verification. CI runs lint, whole-app typecheck, tests and browser checks.
No local full suite, build or browser execution is needed for this acquisition-only change.

Any corresponding hosted workflow update belongs in a separate OSS/cloud lane issue after this
mirror is provisioned and proven. This PR changes no cloud code, development/production Docker
configuration, application behavior, package contents, migrations or browser assertions.
