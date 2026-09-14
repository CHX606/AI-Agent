"""Tiny addition exercise used to verify Bit Agent's agent tool loop."""


def add(a: int, b: int) -> int:
    """Return the sum of two integers."""
    return a + b


def test_addition() -> None:
    assert add(2, 3) == 5
    assert add(-4, 9) == 5
