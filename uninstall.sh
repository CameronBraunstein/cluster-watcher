#!/usr/bin/env bash
# Safely uninstall the per-user Cluster Watcher standalone application.

set -Eeuo pipefail

PROGRAM_NAME="${0##*/}"
BIN_DIR="${XDG_BIN_HOME:-${HOME}/.local/bin}"
CONFIG_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/cluster-watcher"
STATE_DIR="${XDG_STATE_HOME:-${HOME}/.local/state}/cluster-watcher"
PURGE_CONFIG=0
KEEP_PATH=0

usage() {
    cat <<EOF
Usage: ./${PROGRAM_NAME} [OPTIONS]

Uninstall the standalone Cluster Watcher installed by install.sh.

Options:
  --bin-dir DIR       Read the installation from DIR (default: ${BIN_DIR}).
  --config-dir DIR    Locate clusters.toml in DIR (default: ${CONFIG_DIR}).
  --state-dir DIR     Store recovery backups in DIR (default: ${STATE_DIR}).
  --purge-config      Also remove clusters.toml and gpu_profiles.toml (backed up, not destroyed).
  --keep-path         Do not remove the PATH block previously added by install.sh.
  -h, --help          Show this help and exit.

Configuration is preserved by default. Removed files are moved to a timestamped
recovery directory instead of being permanently deleted.
EOF
}

fail() {
    printf '%s: %s\n' "${PROGRAM_NAME}" "$*" >&2
    exit 1
}

while (($#)); do
    case "$1" in
        --bin-dir|--config-dir|--state-dir)
            (($# >= 2)) || fail "$1 requires a directory"
            case "$1" in
                --bin-dir) BIN_DIR="$2" ;;
                --config-dir) CONFIG_DIR="$2" ;;
                --state-dir) STATE_DIR="$2" ;;
            esac
            shift 2
            ;;
        --purge-config)
            PURGE_CONFIG=1
            shift
            ;;
        --keep-path)
            KEEP_PATH=1
            shift
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
[[ "$(id -u)" -ne 0 ]] || fail "run this uninstaller as your normal user, not root"

for directory in "${BIN_DIR}" "${CONFIG_DIR}" "${STATE_DIR}"; do
    [[ ! -L "${directory}" ]] || fail "refusing to use a symbolic-link directory: ${directory}"
done

for command in awk cp chmod date mkdir mktemp mv; do
    command -v "${command}" >/dev/null 2>&1 || fail "required command not found: ${command}"
done

MARKER_PATH="${BIN_DIR}/.cluster-watcher-install"
COMMAND_PATH="${BIN_DIR}/cluster-watcher"
CONFIG_PATH="${CONFIG_DIR}/clusters.toml"
PROFILES_PATH="${CONFIG_DIR}/gpu_profiles.toml"
LEGACY_BINARY_PATH="${BIN_DIR}/.cluster-watcher-bin"
LEGACY_COMMAND_PATH="${BIN_DIR}/cluster_watcher"
[[ ! -L "${MARKER_PATH}" ]] || fail "refusing to read symbolic-link installation manifest: ${MARKER_PATH}"
[[ -f "${MARKER_PATH}" ]] || fail "no installation manifest found at ${MARKER_PATH}"

manifest_version=""
manifest_binary=""
manifest_command=""
manifest_config=""
manifest_profile=""
while IFS= read -r entry || [[ -n "${entry}" ]]; do
    case "${entry}" in
        version=*) manifest_version="${entry#version=}" ;;
        binary=*) manifest_binary="${entry#binary=}" ;;
        command=*) manifest_command="${entry#command=}" ;;
        config=*) manifest_config="${entry#config=}" ;;
        profile=*) manifest_profile="${entry#profile=}" ;;
    esac
done <"${MARKER_PATH}"

LEGACY_INSTALL=0
if [[ "${manifest_version}" == "2" ]]; then
    [[ "${manifest_command}" == "${COMMAND_PATH}" ]] || fail "manifest command does not match ${COMMAND_PATH}"
    [[ "${manifest_config}" == "${CONFIG_PATH}" ]] || fail "manifest configuration does not match ${CONFIG_PATH}"
    [[ "${manifest_binary%/*}" == "${BIN_DIR}" ]] || fail "manifest executable is outside ${BIN_DIR}"
    binary_name="${manifest_binary##*/}"
    [[ "${binary_name}" == cluster-watcher-*-* ]] || fail "manifest executable has an unexpected name: ${binary_name}"
    BINARY_PATH="${manifest_binary}"
    if [[ -n "${manifest_profile}" ]]; then
        case "${manifest_profile}" in
            "${HOME}/.bashrc"|"${HOME}/.bashrc_private"|"${HOME}/.zshrc"|"${HOME}/.zshrc_private"|"${HOME}/.profile"|"${HOME}/.profile_private") ;;
            *) fail "manifest contains an unsafe shell profile: ${manifest_profile}" ;;
        esac
    fi
elif [[ "$(<"${MARKER_PATH}")" == "${LEGACY_BINARY_PATH}" ]]; then
    LEGACY_INSTALL=1
    BINARY_PATH="${LEGACY_BINARY_PATH}"
    manifest_profile=""
else
    fail "installation manifest is not recognized; no files were changed"
fi

for target in "${BINARY_PATH}" "${COMMAND_PATH}" "${MARKER_PATH}"; do
    [[ ! -L "${target}" ]] || fail "refusing to remove symbolic link: ${target}"
    [[ ! -e "${target}" || -f "${target}" ]] || fail "refusing to remove non-file path: ${target}"
done
if [[ "${LEGACY_INSTALL}" -eq 1 ]]; then
    [[ ! -L "${LEGACY_COMMAND_PATH}" ]] || fail "refusing to remove symbolic link: ${LEGACY_COMMAND_PATH}"
    [[ ! -e "${LEGACY_COMMAND_PATH}" || -f "${LEGACY_COMMAND_PATH}" ]] || fail "refusing to remove non-file path: ${LEGACY_COMMAND_PATH}"
fi
if [[ "${PURGE_CONFIG}" -eq 1 ]]; then
    [[ ! -L "${CONFIG_PATH}" ]] || fail "refusing to remove symbolic-link configuration: ${CONFIG_PATH}"
    [[ ! -e "${CONFIG_PATH}" || -f "${CONFIG_PATH}" ]] || fail "configuration is not a regular file: ${CONFIG_PATH}"
    [[ ! -L "${PROFILES_PATH}" ]] || fail "refusing to remove symbolic-link GPU profiles: ${PROFILES_PATH}"
    [[ ! -e "${PROFILES_PATH}" || -f "${PROFILES_PATH}" ]] || fail "GPU profiles are not a regular file: ${PROFILES_PATH}"
fi

BACKUP_DIR="${STATE_DIR}/uninstall-backup-$(date -u +%Y%m%dT%H%M%SZ).$$"
mkdir -p -- "${STATE_DIR}"
[[ -d "${STATE_DIR}" && -w "${STATE_DIR}" ]] || fail "state directory is not writable: ${STATE_DIR}"
mkdir -m 0700 -- "${BACKUP_DIR}"

if [[ "${KEEP_PATH}" -eq 0 && -n "${manifest_profile}" ]]; then
    PROFILE_PATH="${manifest_profile}"
    if [[ -L "${PROFILE_PATH}" ]]; then
        fail "refusing to edit symbolic-link shell profile: ${PROFILE_PATH}"
    fi
    if [[ -f "${PROFILE_PATH}" ]]; then
        PATH_BLOCK_START='# >>> cluster-watcher initialize >>>'
        PATH_BLOCK_NOTICE="# !! Contents within this block are managed by 'cluster-watcher install.sh' !!"
        PATH_BLOCK_END='# <<< cluster-watcher initialize <<<'
        LEGACY_PATH_COMMENT='# Added by Cluster Watcher install.sh'
        PATH_LINE="export PATH='${BIN_DIR}':\"\$PATH\""
        PROFILE_TEMP="$(mktemp "${PROFILE_PATH}.cluster-watcher-uninstall.XXXXXX")"
        set +e
        awk \
            -v block_start="${PATH_BLOCK_START}" \
            -v block_notice="${PATH_BLOCK_NOTICE}" \
            -v block_end="${PATH_BLOCK_END}" \
            -v legacy_comment="${LEGACY_PATH_COMMENT}" \
            -v path_line="${PATH_LINE}" '
            $0 == block_start {
                notice_status = getline notice
                path_status = getline managed_path
                end_status = getline closing
                if (notice_status > 0 && path_status > 0 && end_status > 0 &&
                        notice == block_notice && managed_path == path_line && closing == block_end) {
                    removed = 1
                    next
                }
                print
                if (notice_status > 0) print notice
                if (path_status > 0) print managed_path
                if (end_status > 0) print closing
                next
            }
            $0 == legacy_comment {
                if ((getline following) > 0 && following == path_line) {
                    removed = 1
                    next
                }
                print
                if (following != "") print following
                next
            }
            { print }
            END { if (!removed) exit 3 }
        ' "${PROFILE_PATH}" >"${PROFILE_TEMP}"
        awk_status=$?
        set -e
        if [[ "${awk_status}" -eq 0 ]]; then
            cp -p -- "${PROFILE_PATH}" "${BACKUP_DIR}/${PROFILE_PATH##*/}"
            chmod --reference="${PROFILE_PATH}" "${PROFILE_TEMP}"
            mv -f -- "${PROFILE_TEMP}" "${PROFILE_PATH}"
            printf 'Removed the managed PATH entry from %s\n' "${PROFILE_PATH}"
        elif [[ "${awk_status}" -eq 3 ]]; then
            mv -- "${PROFILE_TEMP}" "${BACKUP_DIR}/profile-without-matching-path-block"
            printf 'WARNING: managed PATH block was not found in %s; profile was unchanged.\n' "${PROFILE_PATH}" >&2
        else
            mv -- "${PROFILE_TEMP}" "${BACKUP_DIR}/profile-edit-failed"
            fail "could not safely edit ${PROFILE_PATH}"
        fi
    fi
elif [[ "${KEEP_PATH}" -eq 0 && "${LEGACY_INSTALL}" -eq 1 ]]; then
    printf 'WARNING: the legacy manifest did not record a shell profile; PATH was not edited.\n' >&2
fi

move_to_backup() {
    local source="$1"
    if [[ -e "${source}" ]]; then
        mv -- "${source}" "${BACKUP_DIR}/${source##*/}"
        printf 'Removed %s\n' "${source}"
    fi
}

move_to_backup "${BINARY_PATH}"
move_to_backup "${COMMAND_PATH}"
if [[ "${LEGACY_INSTALL}" -eq 1 ]]; then
    move_to_backup "${LEGACY_COMMAND_PATH}"
fi
if [[ "${PURGE_CONFIG}" -eq 1 ]]; then
    move_to_backup "${CONFIG_PATH}"
    move_to_backup "${PROFILES_PATH}"
else
    printf 'Preserved configuration: %s\n' "${CONFIG_PATH}"
fi
move_to_backup "${MARKER_PATH}"

printf '\nCluster Watcher was uninstalled.\n'
printf 'Recovery backup: %s\n' "${BACKUP_DIR}"
