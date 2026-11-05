pub mod types;

pub struct Counter;

impl Counter {
    pub fn value(&self) -> u32 {
        answer()
    }
}

pub fn answer() -> u32 {
    42
}

pub fn untested(value: u32) -> u32 {
    if value > 10 {
        value * 2
    } else {
        value + 1
    }
}

pub fn clippy_example() -> bool {
    return true;
}

// This fixture credential is intentionally fake.
pub const FIXTURE_KEY: &str = "AKIA0123456789ABCDEF";

#[cfg(test)]
mod tests {
    use super::answer;

    #[test]
    fn answer_is_42() {
        assert_eq!(answer(), 42);
    }
}
