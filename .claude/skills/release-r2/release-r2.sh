#!/usr/bin/env bash
# Build memotepad's macOS .dmg and upload it to Cloudflare R2.
#
# Mirrors .github/workflows/backup/release.yml: same credentials, same object
# keys (versioned + `latest`), so a local publish is indistinguishable from a
# CI one. Uploads are plain S3 PUTs signed with SigV4 by hand (openssl + curl)
# so no `aws` CLI / wrangler / rclone install is required — run `--selftest` to
# check the signer against AWS's published test vector.
#
# Credentials come from .env at the repo root (git-ignored). See .env.example.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

usage() {
  cat <<'USAGE'
Usage: release-r2.sh --version vX.Y.Z [options]

Required:
  --version <vX.Y.Z>                Release version, e.g. v0.3.0. Sets the R2 folder.

Options:
  --target <host|aarch64|x64|both>  Which macOS arch to build (default: host)
  --skip-build                      Upload the .dmg already in target/, don't rebuild
  --dry-run                         Build + resolve keys, print what would upload, no PUT
  --no-latest                       Publish only the versioned key, skip releases/latest/
  --selftest                        Verify the SigV4 signer against AWS's test vector, exit
  -h, --help                        Show this help
USAGE
}

VERSION=""
TARGETS_ARG="host"
SKIP_BUILD=0
DRY_RUN=0
PUBLISH_LATEST=1

# ---------------------------------------------------------------- SigV4 ----

# sha256_hex <string>  /  sha256_file_hex <path>
sha256_hex() { printf '%s' "$1" | openssl dgst -sha256 -binary | xxd -p -c 256; }
sha256_file_hex() { openssl dgst -sha256 -binary "$1" | xxd -p -c 256; }

# hmac_hex <message> <hex-key>
hmac_hex() {
  printf '%s' "$1" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$2" -binary | xxd -p -c 256
}

# sigv4_authorization <method> <uri> <query> <canonical-headers> <signed-headers>
#                     <payload-hash> <amzdate> <datestamp> <region> <service>
#                     <access-key> <secret-key>
# canonical-headers must be the full block, each line "name:value" + trailing newline.
sigv4_authorization() {
  local method=$1 uri=$2 query=$3 headers=$4 signed=$5 payload=$6
  local amzdate=$7 datestamp=$8 region=$9 service=${10} akid=${11} secret=${12}

  # `$(...)` strips the header block's trailing newline, so re-add the blank
  # line that must separate canonical headers from signed headers.
  local canonical_request
  canonical_request=$(printf '%s\n%s\n%s\n%s\n\n%s\n%s' \
    "$method" "$uri" "$query" "${headers%%$'\n'}" "$signed" "$payload")

  local scope="${datestamp}/${region}/${service}/aws4_request"
  local string_to_sign
  string_to_sign=$(printf 'AWS4-HMAC-SHA256\n%s\n%s\n%s' \
    "$amzdate" "$scope" "$(sha256_hex "$canonical_request")")

  local k
  k=$(printf '%s' "$datestamp" | openssl dgst -sha256 -hmac "AWS4${secret}" -binary | xxd -p -c 256)
  k=$(hmac_hex "$region" "$k")
  k=$(hmac_hex "$service" "$k")
  k=$(hmac_hex "aws4_request" "$k")
  local signature
  signature=$(hmac_hex "$string_to_sign" "$k")

  printf 'AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s' \
    "$akid" "$scope" "$signed" "$signature"
}

# AWS SigV4 test suite, get-vanilla. Proves the signer, no credentials needed.
selftest() {
  local empty auth got
  empty=$(sha256_hex "")
  auth=$(sigv4_authorization "GET" "/" "" \
    "$(printf 'host:example.amazonaws.com\nx-amz-date:20150830T123600Z\n')" \
    "host;x-amz-date" "$empty" "20150830T123600Z" "20150830" "us-east-1" "service" \
    "AKIDEXAMPLE" "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY")
  got=${auth##*Signature=}
  local want="5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
  if [ "$got" = "$want" ]; then
    echo "SigV4 selftest: OK"
  else
    echo "SigV4 selftest: FAILED" >&2
    echo "  expected $want" >&2
    echo "  got      $got" >&2
    return 1
  fi
}

# put_object <local-file> <object-key>
put_object() {
  local file=$1 key=$2
  local host="${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  local uri="/${R2_BUCKET}/${key}"
  local amzdate datestamp payload
  amzdate=$(date -u +%Y%m%dT%H%M%SZ)
  datestamp=${amzdate%%T*}
  payload=$(sha256_file_hex "$file")

  local ctype="application/x-apple-diskimage"
  local headers
  headers=$(printf 'content-type:%s\nhost:%s\nx-amz-content-sha256:%s\nx-amz-date:%s\n' \
    "$ctype" "$host" "$payload" "$amzdate")
  local signed="content-type;host;x-amz-content-sha256;x-amz-date"

  local auth
  auth=$(sigv4_authorization "PUT" "$uri" "" "$headers" "$signed" "$payload" \
    "$amzdate" "$datestamp" "auto" "s3" "$R2_ACCESS_KEY_ID" "$R2_SECRET_ACCESS_KEY")

  local body status
  body=$(mktemp)
  status=$(curl -sS -o "$body" -w '%{http_code}' -X PUT "https://${host}${uri}" \
    -H "Authorization: ${auth}" \
    -H "x-amz-date: ${amzdate}" \
    -H "x-amz-content-sha256: ${payload}" \
    -H "Content-Type: ${ctype}" \
    -H "Expect:" \
    --upload-file "$file") || { rm -f "$body"; echo "curl failed for ${key}" >&2; return 1; }

  if [ "$status" != "200" ]; then
    echo "Upload failed (HTTP ${status}) for s3://${R2_BUCKET}/${key}" >&2
    sed -e 's/^/  /' "$body" >&2
    rm -f "$body"
    return 1
  fi
  rm -f "$body"
  echo "  uploaded s3://${R2_BUCKET}/${key}"
}

# ----------------------------------------------------------------- main ----

while [ $# -gt 0 ]; do
  case $1 in
    --version|-v) VERSION=${2:?--version needs a value}; shift 2 ;;
    --target) TARGETS_ARG=${2:?--target needs a value}; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --no-latest) PUBLISH_LATEST=0; shift ;;
    --selftest) selftest; exit $? ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

cd "$REPO_ROOT"

# Credentials -----------------------------------------------------------------
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

missing=()
for var in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do
  [ -n "${!var:-}" ] || missing+=("$var")
done
if [ ${#missing[@]} -gt 0 ] && [ "$DRY_RUN" -eq 0 ]; then
  echo "Missing R2 credentials in .env: ${missing[*]}" >&2
  echo "Copy .env.example to .env and fill it in." >&2
  exit 1
fi

R2_PREFIX=${R2_PREFIX:-memotepad/releases}
R2_PUBLIC_BASE_URL=${R2_PUBLIC_BASE_URL:-}

# Targets ---------------------------------------------------------------------
host_target() {
  case "$(uname -m)" in
    arm64) echo "aarch64-apple-darwin aarch64" ;;
    x86_64) echo "x86_64-apple-darwin x64" ;;
    *) echo "Unsupported host arch: $(uname -m)" >&2; exit 1 ;;
  esac
}

read -r host_target_triple _ <<<"$(host_target)"

targets=()
case "$TARGETS_ARG" in
  host) targets+=("$(host_target)") ;;
  aarch64|arm64) targets+=("aarch64-apple-darwin aarch64") ;;
  x64|x86_64) targets+=("x86_64-apple-darwin x64") ;;
  both) targets+=("aarch64-apple-darwin aarch64" "x86_64-apple-darwin x64") ;;
  *) echo "Unknown --target: $TARGETS_ARG (use host|aarch64|x64|both)" >&2; exit 2 ;;
esac

# The version is the release folder name and is always supplied by the caller —
# never inferred, so a publish can't silently land in the wrong folder.
if [ -z "$VERSION" ]; then
  echo "Missing --version. Pass the release version as vMAJOR.MINOR.PATCH, e.g.:" >&2
  echo "  $0 --version v0.3.0" >&2
  exit 2
fi
[[ $VERSION =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "Invalid --version '${VERSION}'. Expected vMAJOR.MINOR.PATCH, e.g. v0.3.0." >&2; exit 2; }

echo "memotepad ${VERSION}"

# Advisory only: the .dmg is built from whatever tauri.conf.json says, so a
# mismatch means the folder name won't match the app's own version string.
conf_version=$(jq -r .version src-tauri/tauri.conf.json 2>/dev/null || echo "")
if [ -n "$conf_version" ] && [ "$conf_version" != "null" ] && [ "v${conf_version}" != "$VERSION" ]; then
  echo "  warning: src-tauri/tauri.conf.json says v${conf_version}, publishing as ${VERSION}"
fi

for entry in "${targets[@]}"; do
  read -r target arch <<<"$entry"
  echo
  echo "== ${arch} (${target}) =="

  if [ "$SKIP_BUILD" -eq 0 ]; then
    rustup target list --installed 2>/dev/null | grep -qx "$target" || {
      echo "Rust target ${target} is not installed. Run: rustup target add ${target}" >&2
      exit 1
    }
    npm run tauri build -- --target "$target"
  fi

  # Newest .dmg for this arch. A plain `npm run tauri build` (no --target) drops
  # its bundle in target/release/ instead, so search there too for the host arch.
  dmg_dirs=("src-tauri/target/${target}/release/bundle/dmg")
  [ "$target" = "$host_target_triple" ] && dmg_dirs+=("src-tauri/target/release/bundle/dmg")
  candidates=()
  for dir in "${dmg_dirs[@]}"; do
    for f in "$dir"/*.dmg; do [ -f "$f" ] && candidates+=("$f"); done
  done
  dmg=""
  [ ${#candidates[@]} -gt 0 ] && dmg=$(ls -t "${candidates[@]}" | head -n1)
  if [ -z "$dmg" ]; then
    echo "No .dmg found under: ${dmg_dirs[*]}" >&2
    [ "$SKIP_BUILD" -eq 1 ] && echo "(--skip-build was set — build it first.)" >&2
    exit 1
  fi
  echo "  artifact ${dmg} ($(du -h "$dmg" | cut -f1))"

  # Publish under a stable filename: memotepad_0.3.0_aarch64.dmg -> memotepad-aarch64.dmg
  name="memotepad-${arch}.dmg"
  renamed="$(dirname "$dmg")/${name}"
  if [ "$dmg" != "$renamed" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      echo "  [dry-run] would rename to ${renamed}"
    else
      mv -f "$dmg" "$renamed"
      echo "  renamed  ${renamed}"
    fi
    dmg="$renamed"
  fi
  keys=("${R2_PREFIX}/${VERSION}/${name}")
  [ "$PUBLISH_LATEST" -eq 1 ] && keys+=("${R2_PREFIX}/latest/${name}")

  for key in "${keys[@]}"; do
    case "$key" in
      *[!A-Za-z0-9/._-]*) echo "Refusing unsafe object key: ${key}" >&2; exit 1 ;;
    esac
    if [ "$DRY_RUN" -eq 1 ]; then
      echo "  [dry-run] would PUT s3://${R2_BUCKET:-<bucket>}/${key}"
    else
      put_object "$dmg" "$key"
      [ -n "$R2_PUBLIC_BASE_URL" ] && echo "    ${R2_PUBLIC_BASE_URL%/}/${key}"
    fi
  done
done

echo
echo "Done."
