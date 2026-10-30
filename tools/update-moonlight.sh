#!/usr/bin/env bash
# =============================================================================
# Moonlight updater for Termux
#
# Downloads the newest Moonlight APK from this project's GitHub Releases, checks it, and installs it
# over the app you already have (same signing key, so your music, settings and lists stay).
# Use it when the in-app updater can't (an old build that checks the wrong repo, no internet inside
# the app, or you simply prefer it).
#
#   bash update-moonlight.sh              download the newest version and install it
#   bash update-moonlight.sh --check      only say what the newest version is
#   bash update-moonlight.sh --force      install even if it looks like you already have it
#   bash update-moonlight.sh --installed v1.02.00   tell it which version you have right now
#   MOONLIGHT_REPO=owner/name bash update-moonlight.sh     another repository
#
# How it installs, best first:
#   1. root (su)         silent
#   2. Shizuku (rish)    silent, if Shizuku is running and Termux was given access
#   3. the Android installer: Termux opens it and you tap Install (needs "Install unknown apps"
#      allowed for Termux, and Termux:API's termux-open, which `pkg install termux-api` provides)
# One-time setup:  pkg install curl   (and `termux-setup-storage` so the APK lands in Downloads)
# =============================================================================
set -u

REPO="${MOONLIGHT_REPO:-ScellyP/Moon-light}"
API="https://api.github.com/repos/${REPO}/releases/latest"
MIME="application/vnd.android.package-archive"
STATE="${MOONLIGHT_STATE:-$HOME/.moonlight-installed-version}"
if [ -n "${MOONLIGHT_DIR:-}" ]; then
  DIR="$MOONLIGHT_DIR"
elif [ -d "$HOME/storage/downloads" ]; then
  DIR="$HOME/storage/downloads/Moonlight"
else
  DIR="$HOME/moonlight-updates"
fi

FORCE=0
CHECK=0
INSTALLED=""

usage() {
  sed -n '3,24p' "$0" | sed 's/^# \{0,1\}//'
}

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    -f|--force) FORCE=1 ;;
    -c|--check) CHECK=1 ;;
    -i|--installed) shift; INSTALLED="${1:-}" ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

command -v curl >/dev/null 2>&1 || die "curl is missing. Run:  pkg install curl"

# "v1.10.00" -> "1 10 0" (numbers, so v1.10.00 is newer than v1.9.5)
ver_parts() { printf '%s' "$1" | sed 's/^[vV]//' | awk -F. '{ printf "%d %d %d", $1 + 0, $2 + 0, $3 + 0 }'; }
# ver_gt A B: success when A is a newer version than B
ver_gt() {
  # shellcheck disable=SC2046
  set -- $(ver_parts "$1") $(ver_parts "$2")
  if [ "$1" -ne "$4" ]; then [ "$1" -gt "$4" ]; return; fi
  if [ "$2" -ne "$5" ]; then [ "$2" -gt "$5" ]; return; fi
  [ "$3" -gt "$6" ]
}

# ---- ask GitHub what the newest release is -----------------------------------------------------
say "Checking https://github.com/${REPO} ..."
TMP="$(mktemp 2>/dev/null || echo "${TMPDIR:-/tmp}/moonlight-release.$$")"
trap 'rm -f "$TMP"' EXIT
CODE="$(curl -sS -L -H 'Accept: application/vnd.github+json' -o "$TMP" -w '%{http_code}' "$API")" \
  || die "Could not reach GitHub. Check your internet connection."
case "$CODE" in
  200) ;;
  404) die "No release found at https://github.com/${REPO}/releases. The repository must be public and have a published Release." ;;
  403|429) die "GitHub is limiting requests right now. Try again in a few minutes." ;;
  *) die "GitHub answered HTTP ${CODE}." ;;
esac

TAG="$(grep -m1 '"tag_name"' "$TMP" | sed 's/.*"tag_name"[^"]*"\([^"]*\)".*/\1/')"
URL="$(grep '"browser_download_url"' "$TMP" | grep -i '\.apk"' | head -1 | sed 's/.*"browser_download_url"[^"]*"\([^"]*\)".*/\1/')"
# The checksum GitHub lists for the .apk asset (the digest line that follows the .apk's name).
SHA="$(awk '
  /"name"[[:space:]]*:/ { want = ($0 ~ /\.apk"/) }
  want && /"digest"[[:space:]]*:/ { if (match($0, /sha256:[0-9a-fA-F]+/)) { print substr($0, RSTART + 7, RLENGTH - 7); exit } }
' "$TMP" | tr 'A-F' 'a-f')"

[ -n "$TAG" ] || die "Could not read the release information from GitHub."
[ -n "$URL" ] || die "The latest release (${TAG}) has no APK attached yet. Wait for the build to finish, then try again."

CURRENT="$INSTALLED"
if [ -z "$CURRENT" ] && [ -f "$STATE" ]; then CURRENT="$(cat "$STATE")"; fi

say "Newest release: ${TAG}"
if [ -n "$CURRENT" ]; then say "You have:       ${CURRENT}"; fi

if [ "$FORCE" -eq 0 ] && [ -n "$CURRENT" ] && ! ver_gt "$TAG" "$CURRENT"; then
  say "Already up to date."
  exit 0
fi
if [ "$CHECK" -eq 1 ]; then
  say "Run this script without --check to download and install it."
  exit 0
fi

# ---- download and check ------------------------------------------------------------------------
verify() {
  [ -s "$1" ] || return 1
  if [ -n "$SHA" ]; then
    [ "$(sha256sum "$1" | cut -d' ' -f1)" = "$SHA" ]
  else
    [ "$(head -c 2 "$1")" = "PK" ]     # no checksum listed: at least make sure it is a zip/APK
  fi
}

mkdir -p "$DIR" || die "Cannot create ${DIR}. Run termux-setup-storage first, or set MOONLIGHT_DIR."
APK="${DIR}/moonlight-${TAG}.apk"
if [ -f "$APK" ] && verify "$APK"; then
  say "Already downloaded: ${APK}"
else
  say "Downloading ${TAG} ..."
  if ! curl -fL --progress-bar -o "${APK}.part" "$URL"; then
    rm -f "${APK}.part"
    die "The download failed."
  fi
  mv "${APK}.part" "$APK"
  if ! verify "$APK"; then
    rm -f "$APK"
    die "The download is damaged (checksum does not match). Try again."
  fi
  if [ -n "$SHA" ]; then say "Checksum OK."; fi
fi

# Keep only the two newest downloads.
# shellcheck disable=SC2012
ls -1t "$DIR"/moonlight-v*.apk 2>/dev/null | tail -n +3 | while read -r old; do rm -f "$old"; done

# ---- install -----------------------------------------------------------------------------------
installed_ok() { printf '%s\n' "$TAG" > "$STATE"; }

REAL="$(readlink -f "$APK" 2>/dev/null || echo "$APK")"

# 1. root
if command -v su >/dev/null 2>&1 && su -c id >/dev/null 2>&1; then
  say "Installing with root ..."
  if su -c "cp '${REAL}' /data/local/tmp/moonlight-update.apk && chmod 644 /data/local/tmp/moonlight-update.apk && pm install -r /data/local/tmp/moonlight-update.apk; rc=\$?; rm -f /data/local/tmp/moonlight-update.apk; exit \$rc"; then
    say "Done: Moonlight ${TAG} is installed."
    installed_ok
    exit 0
  fi
  say "The root install did not work, trying the next way."
fi

# 2. Shizuku
if command -v rish >/dev/null 2>&1; then
  say "Installing with Shizuku ..."
  OUT="$(rish -c "pm install -r '${REAL}'" 2>&1)"
  case "$OUT" in
    *Success*)
      say "Done: Moonlight ${TAG} is installed."
      installed_ok
      exit 0
      ;;
  esac
  say "The Shizuku install did not work (${OUT}), trying the next way."
fi

# 3. the Android installer
if command -v termux-open >/dev/null 2>&1; then
  say "Opening the Android installer. Tap Install."
  if termux-open --view --content-type "$MIME" "$REAL"; then
    if [ -t 0 ]; then
      printf 'Did the install finish? [Y/n] '
      read -r ANSWER
      case "$ANSWER" in
        n|N|no|NO) say "Run again with --force to retry." ;;
        *) installed_ok ;;
      esac
    fi
    exit 0
  fi
fi

say "Could not start the install automatically."
say "The APK is here: ${REAL}"
say "Open it from a file manager and tap Install (allow 'Install unknown apps' if asked)."
exit 1
