from pathlib import Path

import pytest
from bit_agent.context import generate_repo_map
from bit_agent.context.ast_index import PythonAstIndex
from bit_agent.context.related_files import RelatedFiles
from bit_agent.models.code_index import ReferenceResolution


def write_file(root: Path, relative: str, content: str) -> None:
    target = root.joinpath(*relative.split("/"))
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def build_related_files(tmp_path: Path) -> RelatedFiles:
    repo_map = generate_repo_map(tmp_path)
    index = PythonAstIndex()
    index.build(tmp_path, repo_map)
    return RelatedFiles(tmp_path, index)


def test_related_files_expands_resolved_calls_imports_and_tests(tmp_path: Path) -> None:
    write_file(
        tmp_path,
        "src/pricing.py",
        "def calculate_total(subtotal: float) -> float:\n    return subtotal\n",
    )
    write_file(
        tmp_path,
        "src/order.py",
        "from src.pricing import calculate_total as calc\n\n"
        "def create_order() -> float:\n"
        "    return calc(100.0)\n",
    )
    write_file(
        tmp_path,
        "tests/test_pricing.py",
        "import src.pricing as pricing\n\n"
        "def test_total() -> None:\n"
        "    assert pricing.calculate_total(100.0) == 100.0\n",
    )

    context = build_related_files(tmp_path).get_symbol_context("src.pricing.calculate_total")

    assert context.candidate.definition.qualified_name == "src.pricing.calculate_total"
    assert context.candidate.detected_call_count == 2
    assert context.candidate.candidate_call_count == 0
    assert context.candidate.detected_import_count == 2
    assert len(context.resolved_references) == 2
    assert all(
        reference.callee_qualified_name == "src.pricing.calculate_total"
        for reference in context.resolved_references
    )
    assert {reference.caller_qualified_name for reference in context.resolved_references} == {
        "src.order.create_order",
        "tests.test_pricing.test_total",
    }
    assert {binding.target_qualified_name for binding in context.imports} == {
        "src.pricing",
        "src.pricing.calculate_total",
    }
    assert context.related_test_paths == ["tests/test_pricing.py"]


def test_related_files_keeps_resolved_duplicate_calls_separate(tmp_path: Path) -> None:
    write_file(tmp_path, "src/alpha.py", "def save() -> None:\n    pass\n")
    write_file(tmp_path, "src/beta.py", "def save() -> None:\n    pass\n")
    write_file(
        tmp_path,
        "src/callers.py",
        "from src.alpha import save as alpha_save\n"
        "from src.beta import save as beta_save\n\n"
        "alpha_save()\n"
        "beta_save()\n",
    )

    related_files = build_related_files(tmp_path)
    alpha = related_files.get_symbol_context("src.alpha.save")
    beta = related_files.get_symbol_context("src.beta.save")

    assert [reference.expression for reference in alpha.resolved_references] == ["alpha_save"]
    assert [reference.expression for reference in beta.resolved_references] == ["beta_save"]
    assert [binding.target_qualified_name for binding in alpha.imports] == ["src.alpha.save"]
    assert [binding.target_qualified_name for binding in beta.imports] == ["src.beta.save"]


def test_related_files_exposes_unresolved_candidates_without_claiming_exact_call(
    tmp_path: Path,
) -> None:
    write_file(
        tmp_path,
        "src/items.py",
        "class Alpha:\n"
        "    def save(self) -> None:\n"
        "        pass\n\n"
        "class Beta:\n"
        "    def save(self) -> None:\n"
        "        pass\n\n"
        "def persist(service) -> None:\n"
        "    service.save()\n",
    )

    context = build_related_files(tmp_path).get_symbol_context("src.items.Alpha.save")

    assert context.resolved_references == []
    assert len(context.candidate_references) == 1
    reference = context.candidate_references[0]
    assert reference.receiver == "service"
    assert reference.resolution is ReferenceResolution.CANDIDATE
    assert reference.candidate_qualified_names == [
        "src.items.Alpha.save",
        "src.items.Beta.save",
    ]


def test_related_files_requires_existing_qualified_name(tmp_path: Path) -> None:
    write_file(tmp_path, "src/pricing.py", "def calculate_total() -> int:\n    return 0\n")
    related_files = build_related_files(tmp_path)

    with pytest.raises(ValueError, match="完整限定名称"):
        related_files.get_symbol_context("calculate_total")
    with pytest.raises(LookupError, match="没有找到符号"):
        related_files.get_symbol_context("src.pricing.missing")
