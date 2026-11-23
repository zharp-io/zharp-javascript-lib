#!/bin/sh
# Electron end to end in Docker: packs the packages, builds the image, runs run.mjs under xvfb.
#   sh test/electron/docker.sh            # Electron 45
#   ELECTRON=43.6.0 sh test/electron/docker.sh
#   WALK=1 sh test/electron/docker.sh     # also walk main's minidump with Electron's own symbols,
#                                         # and leave the backend's fixtures in test/electron/.out
set -e
here=$(cd "$(dirname "$0")" && pwd)
mount=$(cygpath -w "$here" 2>/dev/null || echo "$here")
mkdir -p "$here/.out"
out=$(cygpath -w "$here/.out" 2>/dev/null || echo "$here/.out")
root=$(cd "$here/../.." && pwd)
electron=${ELECTRON:-45.4.1}
rm -rf "$here/.packs" && mkdir -p "$here/.packs"
for p in node electron cli; do (cd "$root/packages/$p" && pnpm pack --pack-destination "$here/.packs" >/dev/null); done
docker build -q --build-arg ELECTRON="$electron" -t "zharp-electron-test:$electron" "$here"
MSYS_NO_PATHCONV=1 docker run --rm --init --shm-size=1g -e WALK="${WALK:-}" -e ONLY="${ONLY:-}" -e VERBOSE="${VERBOSE:-}" -e ZHARP_DEBUG="${ZHARP_DEBUG:-}" \
  -v "$mount:/test:ro" -v "$out:/out" -v zharp-electron-npm:/root/.npm -v zharp-electron-syms:/syms \
  "zharp-electron-test:$electron" sh -c 'cp -r /test/app /work/app && cp /test/.packs/*.tgz /work/ && cd /work/app && \
    npm install --no-audit --no-fund --legacy-peer-deps /work/*.tgz >/dev/null && \
    xvfb-run -a -s "-screen 0 1280x800x24" node /test/run.mjs'
