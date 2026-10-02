#!/usr/bin/env bash
# Install Cluster Watcher for the current user.
#
# By default the prebuilt executable for this machine is downloaded from the
# project's GitHub Releases and verified against the release's SHA256SUMS, so
# neither Python nor a checkout is needed:
#
#   curl -fsSL https://raw.githubusercontent.com/CameronBraunstein/cluster-watcher/master/install.sh | bash
#
# With --from-source, the executable is instead built from this checkout with
# PyInstaller in a disposable virtual environment. No system Python packages
# are changed, and unrelated commands are never overwritten without --force.
#
# Setting CLUSTER_WATCHER_INSTALL_LIB=1 before sourcing this file defines the
# helper functions without running the installer (used by the test suite).

set -Eeuo pipefail

PROGRAM_NAME="cluster-watcher install.sh"
# Piped through bash there is no script file and therefore no checkout.
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
    PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
else
    PROJECT_ROOT=""
fi
REPOSITORY="${CLUSTER_WATCHER_REPO:-CameronBraunstein/cluster-watcher}"
VERSION="latest"
FROM_SOURCE=0
BIN_DIR="${XDG_BIN_HOME:-${HOME}/.local/bin}"
CONFIG_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/cluster-watcher"
STATE_DIR="${XDG_STATE_HOME:-${HOME}/.local/state}/cluster-watcher"
ADD_TO_PATH=0
FORCE=0
WORK_DIR=""

usage() {
    cat <<EOF
Usage: ./install.sh [OPTIONS]    or    curl -fsSL <raw install.sh URL> | bash -s -- [OPTIONS]

Install the standalone Cluster Watcher for the current user. By default the
prebuilt Linux executable is downloaded from GitHub Releases and checked
against the release's SHA256SUMS.

Options:
  --version TAG       Install release TAG (e.g. v0.1.0) instead of the latest.
  --from-source       Build from this checkout with PyInstaller (Python 3.11+).
  --add-to-path       Safely append the install directory to your shell profile.
  --bin-dir DIR       Install commands in DIR (default: ${BIN_DIR}).
  --config-dir DIR    Store clusters.toml in DIR (default: ${CONFIG_DIR}).
  --state-dir DIR     Store migration backups in DIR (default: ${STATE_DIR}).
  --force             Back up and replace conflicting command files.
  -h, --help          Show this help and exit.

The installer creates the single public command "cluster-watcher". Its private
executable is named cluster-watcher-<os>-<architecture>. Existing configuration
is preserved; without one, run "cluster-watcher setup" afterwards.

Environment: CLUSTER_WATCHER_REPO (default ${REPOSITORY}) selects the GitHub
repository; CLUSTER_WATCHER_RELEASE_URL overrides the release download base URL.
EOF
}

fail() {
    printf '%s: %s\n' "${PROGRAM_NAME}" "$*" >&2
    exit 1
}

cleanup() {
    if [[ -n "${WORK_DIR}" && -d "${WORK_DIR}" ]]; then
        case "${WORK_DIR}" in
            "${TMPDIR:-/tmp}"/cluster-watcher-install.*) rm -rf -- "${WORK_DIR}" ;;
            *) printf '%s: refusing to remove unexpected temporary path: %s\n' "${PROGRAM_NAME}" "${WORK_DIR}" >&2 ;;
        esac
    fi
}
# Return the platform-qualified executable name; mirrors
# clusterwatcher.packaging.standalone_artifact_name.
platform_artifact_name() {
    local system machine
    system="$(printf '%s' "${1:-$(uname -s)}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_.]+/-/g; s/^[-.]+//; s/[-.]+$//')"
    machine="$(printf '%s' "${2:-$(uname -m)}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_.]+/-/g; s/^[-.]+//; s/[-.]+$//')"
    case "${machine}" in
        amd64|x64) machine="x86_64" ;;
        arm64) machine="aarch64" ;;
    esac
    printf 'cluster-watcher-%s-%s\n' "${system:-unknown}" "${machine:-unknown}"
}

# Choose the shell profile for --add-to-path, honouring site-managed setups
# whose ~/.bashrc delegates to a private file such as ~/.bashrc_private.
preferred_shell_profile() {
    local home="$1" shell_name="${2##*/}" profile private
    case "${shell_name}" in
        bash) profile="${home}/.bashrc"; private="${home}/.bashrc_private" ;;
        zsh) profile="${home}/.zshrc"; private="${home}/.zshrc_private" ;;
        *) profile="${home}/.profile"; private="${home}/.profile_private" ;;
    esac
    if [[ -f "${profile}" ]] && grep -v '^[[:space:]]*#' -- "${profile}" | grep -Fq -- "${private##*/}"; then
        printf '%s\n' "${private}"
    else
        printf '%s\n' "${profile}"
    fi
}

# Render the marked PATH block that uninstall.sh knows how to remove.
managed_path_block() {
    printf '%s\n' \
        '# >>> cluster-watcher initialize >>>' \
        "# !! Contents within this block are managed by 'cluster-watcher install.sh' !!" \
        "export PATH='$1':\"\$PATH\"" \
        '# <<< cluster-watcher initialize <<<'
}

# Download URL to FILE with curl (preferred) or wget.
download() {
    if command -v curl >/dev/null 2>&1; then
        curl --fail --silent --show-error --location --proto '=https,file' --output "$2" -- "$1"
    elif command -v wget >/dev/null 2>&1; then
        wget --quiet --https-only --output-document="$2" -- "$1"
    else
        fail "curl or wget is required to download a release"
    fi
}

# Print the SHA-256 digest of FILE.
sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum -- "$1" | cut -d' ' -f1
    else
        shasum -a 256 -- "$1" | cut -d' ' -f1
    fi
}

# Download the release executable and verify it against SHA256SUMS.
fetch_release_binary() {
    local artifact="$1" destination="$2" base expected actual
    if [[ -n "${CLUSTER_WATCHER_RELEASE_URL:-}" ]]; then
        base="${CLUSTER_WATCHER_RELEASE_URL%/}"
    elif [[ "${VERSION}" == "latest" ]]; then
        base="https://github.com/${REPOSITORY}/releases/latest/download"
    else
        base="https://github.com/${REPOSITORY}/releases/download/${VERSION}"
    fi
    printf 'Downloading %s (%s) from %s\n' "${artifact}" "${VERSION}" "${base}"
    download "${base}/SHA256SUMS" "${WORK_DIR}/SHA256SUMS" || fail "could not download SHA256SUMS for release ${VERSION}"
    download "${base}/${artifact}" "${destination}" \
        || fail "no ${artifact} in release ${VERSION}; use --from-source on this platform"
    expected="$(awk -v name="${artifact}" '$2 == name || $2 == "*" name { print $1 }' "${WORK_DIR}/SHA256SUMS")"
    [[ "${expected}" =~ ^[0-9a-f]{64}$ ]] || fail "SHA256SUMS has no valid entry for ${artifact}"
    actual="$(sha256_of "${destination}")"
    [[ "${actual}" == "${expected}" ]] || fail "checksum mismatch for ${artifact} (expected ${expected}, got ${actual})"
    chmod 0755 "${destination}"
    printf 'Verified SHA-256 checksum.\n'
}

# Build the executable from the checkout in a disposable virtual environment.
build_from_source() {
    local artifact="$1"
    printf 'Building Cluster Watcher in %s\n' "${WORK_DIR}"
    python3 -m venv "${WORK_DIR}/venv"
    PIP_CACHE_DIR="${WORK_DIR}/pip-cache" "${WORK_DIR}/venv/bin/python" -m pip \
        --disable-pip-version-check install 'pyinstaller>=6.0,<7'
    PYINSTALLER_CONFIG_DIR="${WORK_DIR}/pyinstaller-cache" "${WORK_DIR}/venv/bin/python" -m PyInstaller \
        --noconfirm --clean \
        --distpath "${WORK_DIR}/dist" \
        --workpath "${WORK_DIR}/build" \
        "${PROJECT_ROOT}/cluster-watcher.spec"
    [[ -x "${WORK_DIR}/dist/${artifact}" ]] || fail "PyInstaller did not produce ${artifact}"
}

main() {
while (($#)); do
    case "$1" in
        --add-to-path)
            ADD_TO_PATH=1
            shift
            ;;
        --bin-dir|--config-dir|--state-dir)
            (($# >= 2)) || fail "$1 requires a directory"
            case "$1" in
                --bin-dir) BIN_DIR="$2" ;;
                --config-dir) CONFIG_DIR="$2" ;;
                --state-dir) STATE_DIR="$2" ;;
            esac
            shift 2
            ;;
        --force)
            FORCE=1
            shift
            ;;
        --from-source)
            FROM_SOURCE=1
            shift
            ;;
        --version)
            (($# >= 2)) || fail "--version requires a release tag"
            [[ "$2" =~ ^[A-Za-z0-9._-]+$ ]] || fail "invalid release tag: $2"
            VERSION="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            fail "unknown option: $1 (use --help)"
            ;;
    esac
done

validate_destination() {
    local label="$1" path="$2"
    [[ "${path}" == /* ]] || fail "${label} must be an absolute path: ${path}"
    [[ "${path}" != "/" && "${path}" != "${HOME}" ]] || fail "unsafe ${label}: ${path}"
    [[ "${path}" != *$'\n'* && "${path}" != *":"* && "${path}" != *"'"* ]] || fail "${label} contains unsupported shell characters"
}

validate_destination "binary directory" "${BIN_DIR}"
validate_destination "configuration directory" "${CONFIG_DIR}"
validate_destination "state directory" "${STATE_DIR}"
[[ "$(id -u)" -ne 0 ]] || fail "run this installer as your normal user, not root"

for command in ssh install mktemp grep sed awk tr uname cp mv chmod date; do
    command -v "${command}" >/dev/null 2>&1 || fail "required command not found: ${command}"
done
if [[ "${FROM_SOURCE}" -eq 1 ]]; then
    [[ -n "${PROJECT_ROOT}" && -f "${PROJECT_ROOT}/cluster-watcher.spec" ]] \
        || fail "--from-source must be run from a Cluster Watcher checkout (./install.sh --from-source)"
    command -v python3 >/dev/null 2>&1 || fail "required command not found: python3"
    python3 -c 'import sys; raise SystemExit(sys.version_info < (3, 11))' || fail "Python 3.11 or newer is required on the build machine"
else
    command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || fail "sha256sum or shasum is required"
fi

ARTIFACT_NAME="$(platform_artifact_name)"
[[ "${ARTIFACT_NAME}" == cluster-watcher-*-* && "${ARTIFACT_NAME}" != */* ]] || fail "could not determine a safe standalone artifact name"

for directory in "${BIN_DIR}" "${CONFIG_DIR}" "${STATE_DIR}"; do
    [[ ! -L "${directory}" ]] || fail "refusing to use a symbolic-link directory: ${directory}"
done
mkdir -p -- "${BIN_DIR}" "${CONFIG_DIR}" "${STATE_DIR}"
[[ -d "${BIN_DIR}" && -w "${BIN_DIR}" ]] || fail "binary directory is not writable: ${BIN_DIR}"
[[ -d "${CONFIG_DIR}" && -w "${CONFIG_DIR}" ]] || fail "configuration directory is not writable: ${CONFIG_DIR}"
[[ -d "${STATE_DIR}" && -w "${STATE_DIR}" ]] || fail "state directory is not writable: ${STATE_DIR}"

BINARY_PATH="${BIN_DIR}/${ARTIFACT_NAME}"
COMMAND_PATH="${BIN_DIR}/cluster-watcher"
MARKER_PATH="${BIN_DIR}/.cluster-watcher-install"
CONFIG_PATH="${CONFIG_DIR}/clusters.toml"
LEGACY_BINARY_PATH="${BIN_DIR}/.cluster-watcher-bin"
LEGACY_COMMAND_PATH="${BIN_DIR}/cluster_watcher"
OWNED_INSTALL=0
LEGACY_INSTALL=0
PROFILE_PATH=""

if [[ -L "${MARKER_PATH}" ]]; then
    fail "refusing to use a symbolic-link installation manifest: ${MARKER_PATH}"
elif [[ -f "${MARKER_PATH}" ]]; then
    manifest_version=""
    manifest_binary=""
    manifest_command=""
    manifest_profile=""
    while IFS= read -r entry || [[ -n "${entry}" ]]; do
        case "${entry}" in
            version=*) manifest_version="${entry#version=}" ;;
            binary=*) manifest_binary="${entry#binary=}" ;;
            command=*) manifest_command="${entry#command=}" ;;
            profile=*) manifest_profile="${entry#profile=}" ;;
        esac
    done <"${MARKER_PATH}"
    if [[ "${manifest_version}" == "2" && "${manifest_binary}" == "${BINARY_PATH}" && "${manifest_command}" == "${COMMAND_PATH}" ]]; then
        OWNED_INSTALL=1
        PROFILE_PATH="${manifest_profile}"
        if [[ -n "${PROFILE_PATH}" ]]; then
            case "${PROFILE_PATH}" in
                "${HOME}/.bashrc"|"${HOME}/.bashrc_private"|"${HOME}/.zshrc"|"${HOME}/.zshrc_private"|"${HOME}/.profile"|"${HOME}/.profile_private") ;;
                *) fail "installation manifest contains an unsafe shell profile: ${PROFILE_PATH}" ;;
            esac
        fi
    elif [[ "$(<"${MARKER_PATH}")" == "${LEGACY_BINARY_PATH}" ]]; then
        OWNED_INSTALL=1
        LEGACY_INSTALL=1
    elif [[ "${FORCE}" -ne 1 ]]; then
        fail "installation manifest is not recognized: ${MARKER_PATH} (use --force to back it up)"
    fi
elif [[ -e "${MARKER_PATH}" ]]; then
    fail "installation manifest is not a regular file: ${MARKER_PATH}"
fi

for target in "${BINARY_PATH}" "${COMMAND_PATH}"; do
    if [[ -L "${target}" ]]; then
        fail "refusing to replace symbolic link: ${target}"
    fi
    if [[ -e "${target}" && "${OWNED_INSTALL}" -ne 1 && "${FORCE}" -ne 1 ]]; then
        fail "command path already exists: ${target} (use --force to back it up and replace it)"
    fi
done
if [[ "${LEGACY_INSTALL}" -eq 1 ]]; then
    for target in "${LEGACY_BINARY_PATH}" "${LEGACY_COMMAND_PATH}"; do
        [[ ! -L "${target}" ]] || fail "refusing to migrate symbolic link: ${target}"
        [[ ! -e "${target}" || -f "${target}" ]] || fail "refusing to migrate non-file path: ${target}"
    done
fi
if [[ -L "${CONFIG_PATH}" ]]; then
    fail "refusing to use a symbolic-link configuration: ${CONFIG_PATH}"
fi
if [[ -e "${CONFIG_PATH}" && ! -f "${CONFIG_PATH}" ]]; then
    fail "configuration destination is not a regular file: ${CONFIG_PATH}"
fi

path_contains_bin=0
case ":${PATH}:" in
    *":${BIN_DIR}:"*) path_contains_bin=1 ;;
esac
requested_profile=""
if [[ "${ADD_TO_PATH}" -eq 1 ]]; then
    requested_profile="$(preferred_shell_profile "${HOME}" "${SHELL:-}")"
    PROFILE_BLOCK="$(managed_path_block "${BIN_DIR}")"
    [[ ! -L "${requested_profile}" ]] || fail "refusing to edit symbolic-link profile ${requested_profile}; add ${BIN_DIR} to PATH manually"
    [[ ! -e "${requested_profile}" || -f "${requested_profile}" ]] || fail "shell profile is not a regular file: ${requested_profile}"
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cluster-watcher-install.XXXXXX")"
if [[ "${FROM_SOURCE}" -eq 1 ]]; then
    build_from_source "${ARTIFACT_NAME}"
    BUILT_BINARY="${WORK_DIR}/dist/${ARTIFACT_NAME}"
else
    BUILT_BINARY="${WORK_DIR}/${ARTIFACT_NAME}"
    fetch_release_binary "${ARTIFACT_NAME}" "${BUILT_BINARY}"
fi
"${BUILT_BINARY}" --help >/dev/null \
    || fail "the executable failed its startup check (release builds need glibc 2.17 or newer; try --from-source)"

if [[ "${FORCE}" -eq 1 && "${OWNED_INSTALL}" -ne 1 ]]; then
    BACKUP_DIR="${STATE_DIR}/install-backup-$(date -u +%Y%m%dT%H%M%SZ).$$"
    mkdir -m 0700 -- "${BACKUP_DIR}"
    for target in "${BINARY_PATH}" "${COMMAND_PATH}" "${MARKER_PATH}"; do
        if [[ -e "${target}" ]]; then
            [[ ! -L "${target}" ]] || fail "refusing to back up symbolic link: ${target}"
            mv -- "${target}" "${BACKUP_DIR}/${target##*/}"
            printf 'Backed up %s in %s\n' "${target}" "${BACKUP_DIR}"
        fi
    done
fi

install -m 0755 "${BUILT_BINARY}" "${BINARY_PATH}.new"
mv -f -- "${BINARY_PATH}.new" "${BINARY_PATH}"

{
    printf '%s\n' '#!/bin/sh'
    printf '%s\n' '# Cluster Watcher command shim; managed by install.sh.'
    printf "CLUSTER_WATCHER_COMMAND_NAME='cluster-watcher' exec '%s' --config '%s' \"\$@\"\n" "${BINARY_PATH}" "${CONFIG_PATH}"
} >"${COMMAND_PATH}.new"
chmod 0755 "${COMMAND_PATH}.new"
mv -f -- "${COMMAND_PATH}.new" "${COMMAND_PATH}"

NEEDS_SETUP=0
if [[ ! -e "${CONFIG_PATH}" && -n "${PROJECT_ROOT}" && -f "${PROJECT_ROOT}/clusters.toml" ]]; then
    # A personal, git-ignored clusters.toml beside the installer is adopted once.
    install -m 0600 "${PROJECT_ROOT}/clusters.toml" "${CONFIG_PATH}"
    printf 'Installed configuration: %s\n' "${CONFIG_PATH}"
elif [[ ! -e "${CONFIG_PATH}" ]]; then
    NEEDS_SETUP=1
    printf 'No configuration yet; it will be created at %s\n' "${CONFIG_PATH}"
else
    printf 'Preserved existing configuration: %s\n' "${CONFIG_PATH}"
fi
PROFILES_PATH="${CONFIG_DIR}/gpu_profiles.toml"
if [[ ! -e "${PROFILES_PATH}" && ! -L "${PROFILES_PATH}" && -n "${PROJECT_ROOT}" && -f "${PROJECT_ROOT}/gpu_profiles.toml" ]]; then
    # Likewise adopt a personal, git-ignored GPU catalog once.
    install -m 0600 "${PROJECT_ROOT}/gpu_profiles.toml" "${PROFILES_PATH}"
    printf 'Installed GPU profiles: %s\n' "${PROFILES_PATH}"
fi

if [[ "${ADD_TO_PATH}" -eq 1 ]]; then
    PATH_LINE="export PATH='${BIN_DIR}':\"\$PATH\""
    PROFILE_PATH="${requested_profile}"
    if ! grep -Fqx -- "${PATH_LINE}" "${requested_profile}" 2>/dev/null; then
        if [[ -f "${requested_profile}" ]]; then
            PROFILE_BACKUP="${requested_profile}.cluster-watcher.backup"
            cp -p -- "${requested_profile}" "${PROFILE_BACKUP}"
            printf 'Profile backup: %s\n' "${PROFILE_BACKUP}"
        fi
        printf '\n%s\n' "${PROFILE_BLOCK}" >>"${requested_profile}"
        printf 'Added %s to PATH in %s.\n' "${BIN_DIR}" "${requested_profile}"
        printf 'Open a new shell or run: source %s\n' "${requested_profile}"
    else
        printf '%s is already configured in %s.\n' "${BIN_DIR}" "${requested_profile}"
    fi
elif [[ "${path_contains_bin}" -eq 0 ]]; then
    printf 'WARNING: %s is not currently in PATH.\n' "${BIN_DIR}" >&2
    printf 'Rerun with --add-to-path, or add this line to your shell profile:\n' >&2
    printf "  export PATH='%s':\"\$PATH\"\n" "${BIN_DIR}" >&2
fi

if [[ "${LEGACY_INSTALL}" -eq 1 ]]; then
    MIGRATION_DIR="${STATE_DIR}/migration-backup-$(date -u +%Y%m%dT%H%M%SZ).$$"
    mkdir -m 0700 -- "${MIGRATION_DIR}"
    for target in "${LEGACY_BINARY_PATH}" "${LEGACY_COMMAND_PATH}"; do
        if [[ -e "${target}" ]]; then
            mv -- "${target}" "${MIGRATION_DIR}/${target##*/}"
        fi
    done
    printf 'Moved legacy underscore-named installation files to %s\n' "${MIGRATION_DIR}"
fi

{
    printf 'version=2\n'
    printf 'binary=%s\n' "${BINARY_PATH}"
    printf 'command=%s\n' "${COMMAND_PATH}"
    printf 'config=%s\n' "${CONFIG_PATH}"
    printf 'profile=%s\n' "${PROFILE_PATH}"
} >"${MARKER_PATH}.new"
chmod 0600 "${MARKER_PATH}.new"
mv -f -- "${MARKER_PATH}.new" "${MARKER_PATH}"

printf '\nInstalled command:\n  %s\n' "${COMMAND_PATH}"
printf 'Platform executable:\n  %s\n' "${BINARY_PATH}"
if [[ "${NEEDS_SETUP}" -eq 1 ]]; then
    printf 'Next, describe your clusters with: cluster-watcher setup\n'
fi
printf 'Run from any directory with: cluster-watcher serve --jobs-api\n'
}

if [[ "${CLUSTER_WATCHER_INSTALL_LIB:-0}" != "1" ]]; then
    main "$@"
fi
