# Install and update

Requires a supported OS/architecture and network for downloads; source builds require the pinned Rust toolchain. Installation writes the chosen binary directory; Windows may update user PATH.

## install
Linux/macOS: `curl -fsSL https://raw.githubusercontent.com/pixelinfinito/rio/main/scripts/install.sh -o install.sh`; inspect, then `sh install.sh`. Windows: download `https://raw.githubusercontent.com/pixelinfinito/rio/main/scripts/install.ps1`, inspect it, then run `.\install.ps1`. Published releases, not this source checkout, determine what latest installs: the newest stable release, or the newest pre-release while none is stable (stable acceptance remains pending in the repository records).
`rio --version` prints version, target and commit. Unix default: `~/.local/bin`; Windows: `%LOCALAPPDATA%\Programs\rio\bin`. Add the Unix directory to PATH yourself. Windows `-NoModifyPath` avoids changing PATH.

## versions
`sh install.sh --version VERSION --install-dir DIR`; Windows `-Version VERSION -InstallDir DIR`. Substitute an existing tag for VERSION. Flags override `RIO_VERSION`/`RIO_INSTALL_DIR`. Installers verify SHA-256 before replacement. `gh attestation verify ARCHIVE --repo pixelinfinito/rio` verifies provenance. `RIO_DOWNLOAD_BASE` accepts HTTPS or a local archive/checksum directory.
Source: install Rust from `rust-toolchain.toml`, then `cargo install --path crates/rio-cli --locked`. `RIO_BUILD_VERSION`/`RIO_BUILD_COMMIT` identify archive builds.

## remove
Rerun installer to upgrade/downgrade. `sh install.sh --uninstall` or `.\install.ps1 -Uninstall` keeps personal config; add `--purge`/`-Purge` to delete it. Environment equivalents: `RIO_UNINSTALL=1`, `RIO_PURGE=1`. Source install: `cargo uninstall rio-cli`. Repository caches require deliberate separate removal. Unsupported platforms/checksum failures install nothing; keep the old binary and correct target/download source.
