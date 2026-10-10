# PostgreSQL image acquisition in CI

The verify and OSS boundary service containers use the Docker Official Postgres image from Amazon
ECR Public. The shared product browser job pre-pulls the same image and assigns the local
`postgres:16-alpine` tag before running `apps/oss/e2e/harness.mjs`. That unchanged harness uses
`docker run` with the default missing-image pull policy and does not explicitly pull from Docker Hub.
The ordinary browser smoke job uses verify's service database.

Anonymous Docker Hub pulls returned `toomanyrequests` before tests. This correction removes that
Docker Hub quota dependency without credentials or a harness API change. ECR Public has its own
availability and anonymous quotas; acquisition failure still fails CI. No database assertion or
browser scenario is skipped. Development and production Docker configuration remain unchanged.

## Provenance and pin

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

Keep both service image declarations and shared-browser preparation in sync. Before changing the
pin, compare both registries' raw indexes with `docker buildx imagetools inspect --raw`, check
platform annotations against Official Images source metadata, and run disposable PostgreSQL fixtures
and required CI checks. Keep the explicit version tag and immutable index digest. Do not resolve
moving tags per CI run or fall back to another provider on acquisition failure.

This change affects only CI image acquisition. It preserves migrations, invoice behavior, database
assertions, all existing browser scenarios, published package contents and runtime configuration.
