#!/bin/sh
# Rio installer. All work starts at the final call, so truncated downloads do not run.
main() {
    set -eu
    umask 077
    rio_tmp=
    rio_stage=
    cleanup() {
        [ -z "$rio_stage" ] || rm -f -- "$rio_stage"
        [ -z "$rio_tmp" ] || rm -rf -- "$rio_tmp"
    }
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    fail() { echo "rio install: $*" >&2; exit 1; }
    rio_version=${RIO_VERSION:-latest}
    rio_install_dir=${RIO_INSTALL_DIR:-"$HOME/.local/bin"}
    rio_uninstall=${RIO_UNINSTALL:-0}
    rio_purge=${RIO_PURGE:-0}
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --version) [ "$#" -ge 2 ] || fail '--version needs a value'; rio_version=$2; shift 2 ;;
            --install-dir) [ "$#" -ge 2 ] || fail '--install-dir needs a value'; rio_install_dir=$2; shift 2 ;;
            --uninstall) rio_uninstall=1; shift ;;
            --purge) rio_purge=1; shift ;;
            --help) echo 'Usage: install.sh [--version vX.Y.Z] [--install-dir DIR] [--uninstall] [--purge]'; return 0 ;;
            *) fail "unknown option: $1" ;;
        esac
    done
    [ -n "$rio_install_dir" ] || fail 'install directory is empty'
    # Make relative paths independent of temporary extraction directories.
    case "$rio_install_dir" in /*) ;; *) rio_install_dir=$PWD/$rio_install_dir ;; esac
    rio_config_dir=${RIO_CONFIG_DIR:-${XDG_CONFIG_HOME:-"$HOME/.config"}/rio}
    if [ "$rio_uninstall" = 1 ]; then
        rm -f -- "$rio_install_dir/rio" "$rio_install_dir"/.rio.new.* || fail 'uninstall failed'
        if [ "$rio_purge" = 1 ]; then
            case "$rio_config_dir" in ''|/|.|..|"$HOME") fail 'refusing to purge an unsafe configuration directory' ;; esac
            rm -rf -- "$rio_config_dir" || fail 'configuration purge failed'
            echo "Removed configuration: $rio_config_dir"
        else
            echo "Configuration kept: $rio_config_dir"
        fi
        echo 'Rio uninstalled (or was already absent). Remove repository caches manually: rm -rf <repository>/.rio/cache, or your configured cache.dir.'
        return 0
    fi
    [ "$rio_purge" != 1 ] || fail '--purge requires --uninstall'
    rio_os=${RIO_INSTALL_OS:-$(uname -s)}
    rio_arch=${RIO_INSTALL_ARCH:-$(uname -m)}
    case "$rio_arch" in x86_64|amd64) rio_arch=x86_64 ;; arm64|aarch64) rio_arch=aarch64 ;; *) rio_arch=unsupported ;; esac
    case "$rio_os:$rio_arch" in
        Linux:x86_64|Linux:aarch64) rio_target=$rio_arch-unknown-linux-musl ;;
        Darwin:x86_64|Darwin:aarch64) rio_target=$rio_arch-apple-darwin ;;
        *) fail "unsupported platform $rio_os/$rio_arch. Supported: Linux x86_64, Linux aarch64, macOS x86_64, macOS arm64" ;;
    esac
    fetch() {
        case "$1" in
            https://*)
                if command -v curl >/dev/null 2>&1; then
                    curl --proto '=https' --proto-redir '=https' -fLsS --retry 2 --connect-timeout 15 --max-time 120 "$1" -o "$2" || fail "download failed: $1"
                elif command -v wget >/dev/null 2>&1; then
                    wget --https-only --timeout=120 -q -O "$2" "$1" || fail "download failed: $1"
                else fail 'download needs curl or wget'; fi ;;
            *://*) fail 'only HTTPS URLs or local paths are accepted' ;;
            *) cp -- "$1" "$2" || fail "copy failed: $1" ;;
        esac
    }
    rio_base=${RIO_DOWNLOAD_BASE:-}
    case "$rio_base" in https://*|'') ;; *://*) fail 'only HTTPS URLs or local paths are accepted' ;; *) [ -d "$rio_base" ] || fail "download directory does not exist: $rio_base" ;; esac
    rio_tmp=$(mktemp -d) || fail 'temporary directory creation failed'
    if [ "$rio_version" = latest ]; then
        case "$rio_base" in
            https://*|'')
                if command -v curl >/dev/null 2>&1; then
                    rio_latest=$(curl --proto '=https' --proto-redir '=https' -fLsS --connect-timeout 15 --max-time 120 -o /dev/null -w '%{url_effective}' https://github.com/pixelinfinito/rio/releases/latest) || fail 'latest version resolution failed'
                elif command -v wget >/dev/null 2>&1; then
                    wget --https-only --timeout=120 --server-response -q -O /dev/null https://github.com/pixelinfinito/rio/releases/latest 2> "$rio_tmp/headers" || fail 'latest version resolution failed'
                    rio_latest=$(sed -n 's/^[[:space:]]*[Ll]ocation: \(.*\)[[:space:]]*$/\1/p' "$rio_tmp/headers" | tail -n 1)
                else fail 'latest version resolution needs curl or wget'; fi
                rio_version=${rio_latest##*/} ;;
            *)
                set -- "$rio_base"/rio-*-"$rio_target".tar.gz
                if [ "$#" != 1 ] || [ ! -f "$1" ]; then fail 'local source needs --version when zero or multiple matching archives exist'; fi
                rio_version=${1##*/rio-}; rio_version=${rio_version%-"$rio_target".tar.gz} ;;
        esac
    fi
    case "$rio_version" in v*) ;; *) rio_version=v$rio_version ;; esac
    case "$rio_version" in v[0-9]*.[0-9]*.[0-9]*) ;; *) fail "invalid version: $rio_version" ;; esac
    case "$rio_version" in *[!a-zA-Z0-9.+-]*) fail "invalid version: $rio_version" ;; esac
    [ -n "$rio_base" ] || rio_base=https://github.com/pixelinfinito/rio/releases/download/$rio_version
    rio_base=${rio_base%/}
    rio_archive=rio-${rio_version#v}-$rio_target.tar.gz
    fetch "$rio_base/$rio_archive" "$rio_tmp/$rio_archive"
    fetch "$rio_base/SHA256SUMS" "$rio_tmp/SHA256SUMS"
    rio_expected=$(awk -v name="$rio_archive" '$2 == name || $2 == "*" name {print $1}' "$rio_tmp/SHA256SUMS")
    [ "${#rio_expected}" = 64 ] || fail "checksum entry missing or ambiguous for $rio_archive"
    case "$rio_expected" in *[!a-fA-F0-9]*) fail 'invalid SHA-256 checksum' ;; esac
    if command -v sha256sum >/dev/null 2>&1; then
        rio_actual=$(sha256sum "$rio_tmp/$rio_archive")
    elif command -v shasum >/dev/null 2>&1; then
        rio_actual=$(shasum -a 256 "$rio_tmp/$rio_archive")
    else fail 'verification needs sha256sum or shasum'; fi
    rio_actual=${rio_actual%% *}
    [ "$(printf '%s' "$rio_expected" | tr 'A-F' 'a-f')" = "$rio_actual" ] || fail "checksum mismatch for $rio_archive"
    tar -tzf "$rio_tmp/$rio_archive" > "$rio_tmp/members" || fail 'archive inspection failed'
    while IFS= read -r rio_member; do
        case "$rio_member" in rio|LICENSE|README.md|./rio|./LICENSE|./README.md|./) ;; *) fail "unexpected archive member: $rio_member" ;; esac
    done < "$rio_tmp/members"
    mkdir "$rio_tmp/extract" || fail 'extraction directory creation failed'
    tar -xzf "$rio_tmp/$rio_archive" -C "$rio_tmp/extract" || fail 'archive extraction failed'
    if [ ! -f "$rio_tmp/extract/rio" ] || [ -L "$rio_tmp/extract/rio" ]; then fail 'archive has no regular rio binary'; fi
    mkdir -p -- "$rio_install_dir" || fail 'install directory creation failed'
    rio_stage=$(mktemp "$rio_install_dir/.rio.new.$$.XXXXXX") || fail 'staging file creation failed'
    cp -- "$rio_tmp/extract/rio" "$rio_stage" || fail 'binary staging failed'
    chmod 755 "$rio_stage" || fail 'staged binary permissions failed'
    rio_smoke=$("$rio_stage" --version) || fail 'staged binary smoke test failed; existing rio was kept'
    mv -f -- "$rio_stage" "$rio_install_dir/rio" || fail 'binary publication failed'
    rio_stage=
    echo "Installed $rio_smoke in $rio_install_dir"
    case ":$PATH:" in *:"$rio_install_dir":*) ;; *)
        # Single-quote the directory for a copyable shell command.
        rio_quoted=$(printf '%s' "$rio_install_dir" | sed "s/'/'\\\\''/g")
        # shellcheck disable=SC2016 # Print the user's literal $PATH expression.
        printf 'Add to your shell configuration: export PATH='"'"'%s'"'"':"$PATH"\n' "$rio_quoted" ;;
    esac
}
main "$@"
