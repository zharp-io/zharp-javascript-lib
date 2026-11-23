# Electron on Linux under xvfb, driven by Playwright's _electron, with rust-minidump's walker.
# Built and run by test/electron/docker.sh; see run.mjs for what it checks.
FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb xauth dbus-x11 libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxtst6 libatk-bridge2.0-0 \
      libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libpango-1.0-0 libcairo2 libcups2 \
      xz-utils unzip zip curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# rust-minidump's walker, the release phase 5's backend runs: checksum-verified.
RUN cd /tmp && \
    curl -fsSLO https://github.com/rust-minidump/rust-minidump/releases/download/v0.27.0/minidump-stackwalk-x86_64-unknown-linux-musl.tar.xz && \
    curl -fsSLO https://github.com/rust-minidump/rust-minidump/releases/download/v0.27.0/minidump-stackwalk-x86_64-unknown-linux-musl.tar.xz.sha256 && \
    sha256sum -c minidump-stackwalk-x86_64-unknown-linux-musl.tar.xz.sha256 && \
    tar -xJf minidump-stackwalk-x86_64-unknown-linux-musl.tar.xz && find . -name minidump-stackwalk -type f -exec install {} /usr/local/bin/ \; && \
    rm -rf /tmp/*
ARG ELECTRON=45.4.1
WORKDIR /deps
RUN npm init -y >/dev/null && npm install --no-audit --no-fund electron@${ELECTRON} playwright-core@1.56.1 esbuild@0.27.7 >/dev/null
# The Electron binary itself, into the image (the package fetches it lazily otherwise).
RUN for i in 1 2 3; do (ls node_modules/electron/install.js >/dev/null 2>&1 && node node_modules/electron/install.js || npx --no install-electron) && node -e "require('electron')" && break; sleep 5; done && node -e "console.log(require('electron'))"
ENV NODE_PATH=/deps/node_modules
WORKDIR /work
