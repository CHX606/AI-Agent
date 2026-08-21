from repopilot import __version__


def test_package_version() -> None:
    """确认 RepoPilot 包可以正常导入。"""
    assert __version__ == "0.1.0"