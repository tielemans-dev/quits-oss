# Base image for Cursor cloud agents. Heavy, rarely changing tools live here so
# every Build and agent reuses the cached layers. Do not COPY the repo: Cursor
# checks it out. No secrets here; use Cursor Secrets.
FROM ubuntu:24.04

ARG NODE_VERSION=22.23.3
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git sudo unzip xz-utils postgresql-16 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      | tar -xJ -C /usr/local --strip-components=1 \
    && corepack enable
ARG BUN_VERSION=1.3.9
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash -s "bun-v${BUN_VERSION}"

# Local dev database (password is a local-only default, not a secret).
RUN service postgresql start \
    && su postgres -c "psql -c \"ALTER USER postgres PASSWORD 'postgres';\"" \
    && su postgres -c "createdb quits" \
    && service postgresql stop

RUN id -u ubuntu >/dev/null 2>&1 || useradd -m -s /bin/bash ubuntu; \
    echo "ubuntu ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/ubuntu
