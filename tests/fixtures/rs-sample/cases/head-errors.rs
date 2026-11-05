pub fn existing_error() {
    let value: u32 = "old";
    let other: u32 = "old";
    let _ = (value, other);
}

pub fn added_error() -> u32 {
    "new"
}

pub fn unchanged_error() -> u32 {
    "existing"
}
