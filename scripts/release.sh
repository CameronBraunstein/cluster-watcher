#!/usr/bin/env bash
# Cut a Cluster Watcher release end to end.
#
#   scripts/release.sh patch|minor|major|X.Y.Z [options]
#
# Steps, each of which stops the release on failure:
#   1. Preflight: required tools, clean tree, default branch, up to date with
#      the remote, consistent current versions, target tag not yet taken.
#   2. Local tests: Python suite, extension unit tests, and the VS Code
#      integration test (needs xvfb-run or a display; skip with
#      --skip-integration).
#   3. Bump pyproject.toml, vscode/package.json, vscode/package-lock.json and
#      date the CHANGELOG's "Unreleased" section, then commit.
#   4. Push the commit and wait for the GitHub CI workflow on that exact
#      commit. A failure raises an alert and stops before tagging.
#   5. Push an annotated vX.Y.Z tag and wait for the Release workflow
#      (binaries, VSIX, GitHub Release, Marketplace), alerting on the result.
#
# Re-running with the same explicit version after a CI failure resumes: the
# bump is skipped when the files already carry that version and no tag exists.
#
# Nothing in this script names a person, account, or machine. The repository
# comes from the `origin` remote, the commit/tag author from your own git
# config, and GitHub access from your own `gh auth login`.
#
# Options:
#   --dry-run            Run preflight and tests, show the bump, change nothing.
#   --yes                Do not ask for confirmation before pushing.
#   --skip-tests         Skip local tests (CI still has to pass).
#   --skip-integration   Skip only the local VS Code integration test.
#   --no-watch           Push without waiting for GitHub Actions (no alerts).
#   --remote NAME        Git remote to use (default: origin).
#   -h, --help           Show this help.
#
# Environment:
#   RELEASE_NOTIFY_CMD   Optional command run on every alert with the title and
#                        message as $1 and $2 (for a chat webhook, a pager, ...).
#                        Desktop notifications (notify-send / osascript) and the
#                        terminal bell are used automatically when available.

set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$ROOT"

REMOTE=origin
DRY_RUN=0
ASSUME_YES=0
SKIP_TESTS=0
SKIP_INTEGRATION=0
WATCH=1
BUMP=""

if [[ -t 1 ]]; then
  RED=$'\033[1;31m' GREEN=$'\033[1;32m' YELLOW=$'\033[1;33m' BOLD=$'\033[1m' RESET=$'\033[0m'
else
  RED="" GREEN="" YELLOW="" BOLD="" RESET=""
fi

usage() { sed -n '2,/^$/{s/^# \{0,1\}//;p}' "${BASH_SOURCE[0]}"; }
step() { printf '\n%s==> %s%s\n' "$BOLD" "$*" "$RESET"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%sWARNING:%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die() { printf '%sERROR:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

notify() {
  # notify TITLE MESSAGE: best-effort desktop/hook notification.
  local title="$1" message="$2"
  if command -v notify-send >/dev/null 2>&1; then
    notify-send --urgency=critical "$title" "$message" 2>/dev/null || true
  elif command -v osascript >/dev/null 2>&1; then
    TITLE="$title" MESSAGE="$message" osascript \
      -e 'display notification (system attribute "MESSAGE") with title (system attribute "TITLE")' \
      2>/dev/null || true
  fi
  if [[ -n "${RELEASE_NOTIFY_CMD:-}" ]]; then
    # Deliberately word-split so the variable can carry arguments.
    # shellcheck disable=SC2086
    $RELEASE_NOTIFY_CMD "$title" "$message" || warn "RELEASE_NOTIFY_CMD failed"
  fi
}

alert_failure() {
  # alert_failure TITLE MESSAGE: loud, multi-channel failure alert.
  printf '\a' >&2
  printf '\n%s############################################################%s\n' "$RED" "$RESET" >&2
  printf '%s#  RELEASE FAILED: %s%s\n' "$RED" "$1" "$RESET" >&2
  printf '%s############################################################%s\n' "$RED" "$RESET" >&2
  printf '%s\n' "$2" >&2
  notify "Cluster Watcher release failed: $1" "$2"
}

confirm() {
  (( ASSUME_YES )) && return 0
  [[ -t 0 ]] || die "refusing to continue without a terminal; pass --yes to confirm non-interactively"
  local answer
  read -r -p "$1 [y/N] " answer
  [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]]
}

while (( $# )); do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --skip-integration) SKIP_INTEGRATION=1 ;;
    --no-watch) WATCH=0 ;;
    --remote) shift; REMOTE="${1:?--remote needs a name}" ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option: $1 (see --help)" ;;
    *) [[ -z "$BUMP" ]] || die "only one version argument is allowed"; BUMP="$1" ;;
  esac
  shift
done
[[ -n "$BUMP" ]] || { usage; exit 2; }

# ---------------------------------------------------------------------------
step "Preflight checks"

for tool in git python3 node npm; do
  command -v "$tool" >/dev/null 2>&1 || die "required command not found: $tool"
done
python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))' || die "Python 3.11+ is required (tomllib)"

REMOTE_URL="$(git remote get-url "$REMOTE" 2>/dev/null)" || die "git remote '$REMOTE' does not exist"
# owner/repo from https://github.com/owner/repo(.git), git@github.com:owner/repo(.git)
# or ssh://git@github.com/owner/repo(.git). Proxied URLs keep the last two segments.
REPO_SLUG="$(printf '%s\n' "$REMOTE_URL" | sed -E 's#\.git/?$##; s#/+$##; s#^.*[:/]([^/:]+/[^/:]+)$#\1#')"
[[ "$REPO_SLUG" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "could not read owner/repo from remote '$REMOTE'"
info "repository: $REPO_SLUG (remote '$REMOTE')"

if (( WATCH )) && (( ! DRY_RUN )); then
  command -v gh >/dev/null 2>&1 || die "GitHub CLI 'gh' is needed to watch CI and alert on failures (install it, or pass --no-watch)"
  gh auth status >/dev/null 2>&1 || die "'gh' is not authenticated; run 'gh auth login' (or pass --no-watch)"
fi

git fetch --quiet --tags "$REMOTE" || die "could not fetch from '$REMOTE'"

DEFAULT_BRANCH="$(git symbolic-ref --quiet --short "refs/remotes/$REMOTE/HEAD" 2>/dev/null | sed "s#^$REMOTE/##" || true)"
if [[ -z "$DEFAULT_BRANCH" ]]; then
  DEFAULT_BRANCH="$(git remote show "$REMOTE" 2>/dev/null | sed -n 's/^ *HEAD branch: //p')"
fi
[[ -n "$DEFAULT_BRANCH" && "$DEFAULT_BRANCH" != "(unknown)" ]] || die "could not determine the default branch of '$REMOTE'"

BRANCH="$(git symbolic-ref --quiet --short HEAD)" || die "HEAD is detached; check out '$DEFAULT_BRANCH'"
[[ "$BRANCH" == "$DEFAULT_BRANCH" ]] || die "releases are cut from '$DEFAULT_BRANCH', but you are on '$BRANCH'"

[[ -z "$(git status --porcelain --untracked-files=normal)" ]] \
  || die "working tree is not clean; commit or stash these first:"$'\n'"$(git status --short)"

read -r BEHIND AHEAD < <(git rev-list --left-right --count "$REMOTE/$DEFAULT_BRANCH...HEAD")
(( BEHIND == 0 )) || die "'$DEFAULT_BRANCH' is $BEHIND commit(s) behind $REMOTE; pull first"
(( AHEAD == 0 )) || warn "'$DEFAULT_BRANCH' has $AHEAD unpushed commit(s); they will be pushed with the release"

read_versions() {
  PY_VERSION="$(python3 -c 'import tomllib; print(tomllib.load(open("pyproject.toml", "rb"))["project"]["version"])')"
  EXT_VERSION="$(node -p 'require("./vscode/package.json").version')"
  LOCK_VERSION="$(node -p 'const l = require("./vscode/package-lock.json"); l.version + " " + l.packages[""].version')"
}
read_versions
[[ "$PY_VERSION" == "$EXT_VERSION" && "$LOCK_VERSION" == "$EXT_VERSION $EXT_VERSION" ]] \
  || die "versions disagree: pyproject=$PY_VERSION package.json=$EXT_VERSION package-lock=$LOCK_VERSION"
CURRENT="$PY_VERSION"

SEMVER='^([0-9]+)\.([0-9]+)\.([0-9]+)$'
[[ "$CURRENT" =~ $SEMVER ]] || die "current version '$CURRENT' is not plain X.Y.Z"
MAJOR="${BASH_REMATCH[1]}" MINOR="${BASH_REMATCH[2]}" PATCH="${BASH_REMATCH[3]}"
case "$BUMP" in
  major) NEW="$((MAJOR + 1)).0.0" ;;
  minor) NEW="$MAJOR.$((MINOR + 1)).0" ;;
  patch) NEW="$MAJOR.$MINOR.$((PATCH + 1))" ;;
  *) [[ "$BUMP" =~ $SEMVER ]] || die "version must be major, minor, patch, or X.Y.Z (got '$BUMP')"; NEW="$BUMP" ;;
esac
TAG="v$NEW"

version_gt() { [[ "$1" != "$2" && "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n1)" == "$1" ]]; }

git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "tag $TAG already exists locally"
[[ -z "$(git ls-remote --tags "$REMOTE" "refs/tags/$TAG")" ]] || die "tag $TAG already exists on $REMOTE"

RESUME=0
if [[ "$NEW" == "$CURRENT" ]]; then
  RESUME=1
  info "files already at $NEW and $TAG is untagged: resuming (no new bump)"
else
  version_gt "$NEW" "$CURRENT" || die "$NEW is not newer than the current version $CURRENT"
fi
info "version: $CURRENT -> $NEW (tag $TAG)"

if (( ! RESUME )); then
  UNRELEASED="$(awk '/^## Unreleased/{f=1; next} /^## /{f=0} f && NF' vscode/CHANGELOG.md)"
  grep -q '^## Unreleased' vscode/CHANGELOG.md || die "vscode/CHANGELOG.md has no '## Unreleased' section"
  if [[ -z "$UNRELEASED" ]]; then
    warn "the CHANGELOG 'Unreleased' section is empty"
    (( DRY_RUN )) || confirm "Release $NEW without changelog entries?" || die "aborted"
  fi
fi

# ---------------------------------------------------------------------------
if (( SKIP_TESTS )); then
  warn "skipping local tests (--skip-tests); GitHub CI must still pass"
else
  step "Python test suite"
  if [[ "$(id -u)" == 0 ]]; then
    warn "running as root: the installer tests intentionally refuse root and will fail"
  fi
  python3 -m unittest discover -s tests -t tests \
    || die "Python tests failed; nothing was changed"

  step "VS Code extension unit tests"
  ( cd vscode && npm ci --no-audit --no-fund --loglevel=error && npm test ) \
    || die "extension tests failed; nothing was changed"

  if (( SKIP_INTEGRATION )); then
    warn "skipping the local VS Code integration test (--skip-integration)"
  elif command -v xvfb-run >/dev/null 2>&1; then
    step "VS Code integration test (xvfb)"
    ( cd vscode && xvfb-run -a npm run test:integration ) \
      || die "VS Code integration test failed; nothing was changed"
  elif [[ "$(uname -s)" == Darwin || -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then
    step "VS Code integration test"
    ( cd vscode && npm run test:integration ) \
      || die "VS Code integration test failed; nothing was changed"
  else
    warn "no xvfb-run or display: the integration test will run only in GitHub CI"
  fi
fi

# ---------------------------------------------------------------------------
bump_files() {
  NEW_VERSION="$1" RELEASE_DATE="$(date -u +%Y-%m-%d)" python3 - <<'PY'
import os, re
from pathlib import Path

new, today = os.environ["NEW_VERSION"], os.environ["RELEASE_DATE"]

def replace(path, pattern, replacement, count, flags=0):
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    updated, made = re.subn(pattern, replacement, text, count=count, flags=flags)
    if made != count:
        raise SystemExit(f"{path}: expected {count} version field(s), changed {made}")
    file.write_text(updated, encoding="utf-8")

# [project] version only (the first top-level `version =` line).
replace("pyproject.toml", r'^(version\s*=\s*")[^"]+(")', rf"\g<1>{new}\g<2>", 1, re.M)
# Top-level "version" in package.json (two-space indent = top level).
replace("vscode/package.json", r'^(  "version": ")[^"]+(")', rf"\g<1>{new}\g<2>", 1, re.M)
# package-lock.json: root "version" and packages[""].version, which are the
# first two "version" keys; dependency versions come later.
replace("vscode/package-lock.json", r'("version": ")[^"]+(")', rf"\g<1>{new}\g<2>", 2)
replace("vscode/CHANGELOG.md", r"^## Unreleased[ \t]*\n", f"## Unreleased\n\n## {new} - {today}\n", 1, re.M)
PY
}

if (( RESUME )); then
  :
elif (( DRY_RUN )); then
  step "Dry run: version bump preview"
  bump_files "$NEW"
  git --no-pager diff --stat
  git --no-pager diff -- vscode/CHANGELOG.md | head -n 20
  git checkout --quiet -- pyproject.toml vscode/package.json vscode/package-lock.json vscode/CHANGELOG.md
  info "files restored"
else
  step "Bump version to $NEW"
  bump_files "$NEW"
  read_versions
  [[ "$PY_VERSION" == "$NEW" && "$EXT_VERSION" == "$NEW" && "$LOCK_VERSION" == "$NEW $NEW" ]] \
    || die "version bump did not apply cleanly (pyproject=$PY_VERSION package.json=$EXT_VERSION lock=$LOCK_VERSION)"
  git add pyproject.toml vscode/package.json vscode/package-lock.json vscode/CHANGELOG.md
  git commit --quiet -m "Release $TAG"
  info "committed $(git rev-parse --short HEAD)"
fi

if (( DRY_RUN )); then
  printf '\n%sDry run complete:%s preflight and tests passed; nothing was committed or pushed.\n' "$GREEN" "$RESET"
  exit 0
fi

RELEASE_SHA="$(git rev-parse HEAD)"

# ---------------------------------------------------------------------------
find_run() {
  # find_run WORKFLOW_FILE EVENT: print the run ID for RELEASE_SHA, waiting up to ~3 min.
  local workflow="$1" event="$2" id="" attempt
  for attempt in $(seq 1 36); do
    id="$(gh run list -R "$REPO_SLUG" --workflow "$workflow" --commit "$RELEASE_SHA" --event "$event" \
          --limit 1 --json databaseId --jq '.[0].databaseId // empty' 2>/dev/null || true)"
    [[ -n "$id" ]] && { printf '%s\n' "$id"; return 0; }
    sleep 5
  done
  return 1
}

watch_run() {
  # watch_run WORKFLOW_FILE EVENT LABEL: wait for the run; alert and fail on anything but success.
  local workflow="$1" event="$2" label="$3" id url conclusion
  id="$(find_run "$workflow" "$event")" || {
    alert_failure "$label did not start" \
      "No '$workflow' run appeared for commit ${RELEASE_SHA:0:12} on $REPO_SLUG. Check the Actions tab."
    return 1
  }
  url="$(gh run view "$id" -R "$REPO_SLUG" --json url --jq .url)"
  info "$label: $url"
  gh run watch "$id" -R "$REPO_SLUG" --interval 20 --compact --exit-status >/dev/null 2>&1 || true
  conclusion="$(gh run view "$id" -R "$REPO_SLUG" --json conclusion --jq .conclusion)"
  if [[ "$conclusion" != success ]]; then
    local failed
    failed="$(gh run view "$id" -R "$REPO_SLUG" --json jobs \
      --jq '.jobs[] | select(.conclusion != "success" and .conclusion != "skipped") | "  - \(.name): \(.conclusion)"' || true)"
    alert_failure "$label ($conclusion)" "Run: $url"$'\n'"Failed jobs:"$'\n'"${failed:-  (could not list jobs)}"$'\n'"Logs: gh run view $id -R $REPO_SLUG --log-failed"
    return 1
  fi
  printf '    %s%s passed%s\n' "$GREEN" "$label" "$RESET"
}

step "Push $DEFAULT_BRANCH to $REMOTE"
git --no-pager log --oneline "$REMOTE/$DEFAULT_BRANCH..HEAD" | sed 's/^/    /'
confirm "Push these commit(s) to $REMOTE/$DEFAULT_BRANCH?" || die "aborted before pushing; undo the bump with: git reset --hard $REMOTE/$DEFAULT_BRANCH"
if [[ "$(git rev-parse "$REMOTE/$DEFAULT_BRANCH")" != "$RELEASE_SHA" ]]; then
  git push --quiet "$REMOTE" "HEAD:refs/heads/$DEFAULT_BRANCH" || die "push to $REMOTE/$DEFAULT_BRANCH failed"
fi

if (( WATCH )); then
  step "Waiting for GitHub CI on ${RELEASE_SHA:0:12}"
  watch_run ci.yml push "CI" || die "CI failed, so $TAG was NOT tagged. Fix it on $DEFAULT_BRANCH, then re-run: scripts/release.sh $NEW"
else
  warn "--no-watch: tagging without waiting for CI"
fi

step "Tag and push $TAG"
confirm "Create and push $TAG (starts the public release)?" || die "aborted before tagging; re-run 'scripts/release.sh $NEW' to resume"
git tag -a "$TAG" -m "Cluster Watcher $TAG" "$RELEASE_SHA"
git push --quiet "$REMOTE" "refs/tags/$TAG" || die "pushing $TAG failed; delete the local tag with: git tag -d $TAG"

if (( WATCH )); then
  step "Waiting for the Release workflow"
  if ! watch_run release.yml push "Release workflow"; then
    die "the release workflow failed after $TAG was pushed. Inspect the run; to retry the same version, delete the tag (git push $REMOTE :refs/tags/$TAG && git tag -d $TAG) and any draft GitHub Release, then re-run."
  fi
  notify "Cluster Watcher $TAG released" "https://github.com/$REPO_SLUG/releases/tag/$TAG"
fi

printf '\n%sReleased %s.%s https://github.com/%s/releases/tag/%s\n' "$GREEN" "$TAG" "$RESET" "$REPO_SLUG" "$TAG"
