pub fn existing_error() {
    let value: u32 = "old";
    let _ = value;
}

pub fn unchanged_error() -> u32 {
    "existing"
}
