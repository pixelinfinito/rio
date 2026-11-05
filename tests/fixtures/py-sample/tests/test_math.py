from sample.math import format_value

def test_format_value() -> None:
    assert format_value(12) == "12.00"
