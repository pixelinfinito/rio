fn main() {
    println!("cargo:rerun-if-changed=../../modules");
    println!("cargo:rerun-if-changed=../../schemas");
}
