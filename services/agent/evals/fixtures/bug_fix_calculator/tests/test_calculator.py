"""计算模块的可信回归测试。"""

from calculator import add, multiply, subtract


def test_adds_positive_numbers() -> None:
    assert add(7, 5) == 12


def test_adds_negative_number() -> None:
    assert add(7, -5) == 2


def test_subtracts_numbers() -> None:
    assert subtract(7, 5) == 2


def test_multiplies_numbers() -> None:
    assert multiply(7, 5) == 35
