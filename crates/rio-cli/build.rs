use std::process::Command;
fn main() {
    println!(
        "cargo:rustc-env=RIO_VERSION={}",
        std::env::var("RIO_BUILD_VERSION")
            .unwrap_or_else(|_| std::env::var("CARGO_PKG_VERSION").unwrap())
    );
    println!("cargo:rerun-if-env-changed=RIO_BUILD_VERSION");
    println!(
        "cargo:rustc-env=RIO_TARGET={}",
        std::env::var("TARGET").unwrap()
    );
    let commit = std::env::var("RIO_BUILD_COMMIT")
        .ok()
        .or_else(|| {
            Command::new("git")
                .args(["rev-parse", "--short=12", "HEAD"])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        })
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=RIO_COMMIT={commit}");
    println!("cargo:rerun-if-env-changed=RIO_BUILD_COMMIT");
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    println!("cargo:rerun-if-changed=../../.git/refs");
    println!("cargo:rerun-if-changed=../../.git/packed-refs");
}
