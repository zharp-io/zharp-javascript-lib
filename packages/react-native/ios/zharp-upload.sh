#!/bin/bash
# @zharp/react-native for iOS builds: after React Native's "Bundle React Native code and images"
# phase, the release bundle's source map goes to Zharp, filed under the bundle's debug ID (see
# @zharp/react-native/metro), so JavaScript errors from the release read as the app's own source.
#
# The phase sets SOURCEMAP_FILE first (React Native then writes the composed map there) and calls
# this last:
#
#     export SOURCEMAP_FILE="$DERIVED_FILE_DIR/main.jsbundle.map"
#     … React Native's bundle command …
#     /bin/bash "$PODS_ROOT/../../node_modules/@zharp/react-native/ios/zharp-upload.sh"
#
# It needs ZHARP_AUTH_TOKEN (a workspace API key with the Build uploads scope) and ZHARP_APP (the
# app's ID). Without a token it says so and the build carries on; it never fails a build.

[ "$CONFIGURATION" = "Debug" ] && exit 0

# Node as React Native's own phase finds it: .xcode.env, then .xcode.env.local.
PROJECT_ROOT="${PODS_ROOT:-$SRCROOT/Pods}/../.."
for env_file in "$PODS_ROOT/../.xcode.env" "$PODS_ROOT/../.xcode.env.local"; do
  [ -f "$env_file" ] && . "$env_file"
done
NODE_BINARY="${NODE_BINARY:-$(command -v node)}"

MAP="${SOURCEMAP_FILE:-$DERIVED_FILE_DIR/main.jsbundle.map}"
BUNDLE="$CONFIGURATION_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/main.jsbundle"
if [ ! -f "$BUNDLE" ] || [ ! -f "$MAP" ]; then
  echo "note: Zharp: no release bundle and source map to upload ($BUNDLE, $MAP)."
  exit 0
fi
if [ -z "$ZHARP_AUTH_TOKEN" ]; then
  echo "note: Zharp: ZHARP_AUTH_TOKEN isn't set, so the source map wasn't uploaded; JavaScript errors from this build will show bundle positions."
  exit 0
fi

CLI_PACKAGE="$(cd "$PROJECT_ROOT" && "$NODE_BINARY" --print "require.resolve('@zharp/cli/package.json')" 2>/dev/null)"
if [ -z "$CLI_PACKAGE" ]; then
  echo "warning: Zharp: @zharp/cli wasn't found; the source map wasn't uploaded."
  exit 0
fi
ARGS=(react-native upload --bundle "$BUNDLE" --map "$MAP")
[ -n "$ZHARP_APP" ] && ARGS+=(--app "$ZHARP_APP")
"$NODE_BINARY" "$(dirname "$CLI_PACKAGE")/dist/cli.js" "${ARGS[@]}" || \
  echo "warning: Zharp: the source map upload failed; JavaScript errors from this build will show bundle positions."
exit 0
