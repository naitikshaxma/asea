# Build from the repository root. This image is a local, administrator-built
# toolchain; task containers never pull images or install dependencies.
FROM golang:1.27-bookworm AS osv-build
RUN CGO_ENABLED=0 go install github.com/google/osv-scanner/v2/cmd/osv-scanner@v2.7.0

FROM node:24-bookworm-slim
ARG GITLEAKS_VERSION=8.30.1
ARG SEMGREP_VERSION=1.181.0
ARG INCLUDE_OSV_DATABASE=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl python3 python3-pip python-is-python3 tar coreutils \
  && rm -rf /var/lib/apt/lists/*

COPY --from=osv-build /go/bin/osv-scanner /usr/local/bin/osv-scanner

RUN set -eu; \
  cd /tmp; \
  curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" -o "gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"; \
  curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_checksums.txt" -o gitleaks_checksums.txt; \
  grep " gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz$" gitleaks_checksums.txt | sha256sum --check --status; \
  tar -xzf "gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" -C /usr/local/bin gitleaks; \
  rm -f "gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" gitleaks_checksums.txt

ENV PIP_BREAK_SYSTEM_PACKAGES=1 \
    PIP_NO_CACHE_DIR=1 \
    OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY=/opt/asea/osv-cache \
    SEMGREP_SEND_METRICS=off \
    SEMGREP_ENABLE_VERSION_CHECK=0
RUN python3 -m pip install --no-cache-dir "semgrep==${SEMGREP_VERSION}" "pytest==8.4.2" \
  && mkdir -p /opt/asea/osv-cache /tmp/asea-empty

# Download the advisory database during trusted image construction only.
# Build environments can opt out; scans then report OSV-Scanner unavailable.
RUN if [ "${INCLUDE_OSV_DATABASE}" = "1" ]; then \
      printf '%s\n' '{"name":"asea-osv-database-bootstrap","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"asea-osv-database-bootstrap","version":"1.0.0","dependencies":{"lodash":"4.18.0"}},"node_modules/lodash":{"version":"4.18.0","resolved":"https://registry.npmjs.org/lodash/-/lodash-4.18.0.tgz"}}}' > /tmp/asea-empty/package-lock.json; \
      osv-scanner scan source --offline-vulnerabilities --download-offline-databases --lockfile=/tmp/asea-empty/package-lock.json >/dev/null; \
      test -s /opt/asea/osv-cache/osv-scalibr/npm/all.zip; \
      chmod -R a+rX /opt/asea/osv-cache; \
      rm -rf /tmp/asea-empty; \
    fi

COPY services/api/sandbox/semgrep-rules.yaml /opt/asea/semgrep-rules.yaml
COPY services/api/sandbox/gitleaks.toml /opt/asea/gitleaks.toml
COPY services/api/sandbox/osv-scanner.toml /opt/asea/osv-scanner.toml
RUN chmod 0555 /usr/local/bin/osv-scanner /usr/local/bin/gitleaks \
  && chmod 0444 /opt/asea/semgrep-rules.yaml /opt/asea/gitleaks.toml /opt/asea/osv-scanner.toml \
  && mkdir -p /opt/asea/empty-gitleaks-ignore \
  && chmod 0555 /opt/asea/empty-gitleaks-ignore

WORKDIR /workspace
