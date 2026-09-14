from pathlib import Path

import pytest
from bit_agent.context import generate_repo_map
from bit_agent.context.ast_index import PythonAstIndex
from bit_agent.context.code_search import CodeSearch
from bit_agent.models.code_index import SymbolDefinition, SymbolKind


def write_file(root: Path, relative: str, content: str) -> None:
    target = root.joinpath(*relative.split("/"))
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def build_search(tmp_path: Path) -> CodeSearch:
    repo_map = generate_repo_map(tmp_path)
    index = PythonAstIndex()
    index.build(tmp_path, repo_map)
    return CodeSearch(tmp_path, index)


def test_code_search_builds_symbol_summary_from_resolved_relationships(tmp_path: Path) -> None:
    write_file(
        tmp_path,
        "src/pricing.py",
        "def calculate_total(subtotal: float) -> float:\n    return subtotal\n",
    )
    write_file(
        tmp_path,
        "src/order.py",
        "from src.pricing import calculate_total\n\nresult = calculate_total(100.0)\n",
    )
    write_file(
        tmp_path,
        "tests/test_pricing.py",
        "from src.pricing import calculate_total\n\ndef test_total() -> None:\n"
        "    assert calculate_total(100.0) == 100.0\n",
    )

    result = build_search(tmp_path).search("calculate_total")[0]

    assert result.definition == SymbolDefinition(
        name="calculate_total",
        qualified_name="src.pricing.calculate_total",
        kind=SymbolKind.FUNCTION,
        path="src/pricing.py",
        line=1,
        end_line=2,
    )
    assert "1 | def calculate_total" in result.snippet
    assert result.reason == "精确函数定义"
    assert result.score == 1.0
    assert result.detected_call_count == 2
    assert result.candidate_call_count == 0
    assert result.detected_import_count == 2
    assert result.detected_test_count == 1
    assert not result.truncated


def test_code_search_counts_module_import_used_by_resolved_call(tmp_path: Path) -> None:
    write_file(tmp_path, "src/pricing.py", "def calculate_total() -> int:\n    return 0\n")
    write_file(
        tmp_path,
        "src/order.py",
        "import src.pricing as pricing\n\nresult = pricing.calculate_total()\n",
    )

    result = build_search(tmp_path).search("src.pricing.calculate_total")[0]

    assert result.detected_call_count == 1
    assert result.detected_import_count == 1


def test_code_search_keeps_duplicate_function_counts_separate(tmp_path: Path) -> None:
    write_file(tmp_path, "src/alpha.py", "def save() -> None:\n    pass\n")
    write_file(tmp_path, "src/beta.py", "def save() -> None:\n    pass\n")
    write_file(
        tmp_path,
        "src/alpha_caller.py",
        "from src.alpha import save as alpha_save\n\nalpha_save()\n",
    )
    write_file(
        tmp_path,
        "src/beta_caller.py",
        "from src.beta import save as beta_save\n\nbeta_save()\n",
    )

    search = build_search(tmp_path)
    all_results = search.search("save")
    alpha_result = search.search("src.alpha.save")[0]

    assert [result.definition.qualified_name for result in all_results] == [
        "src.alpha.save",
        "src.beta.save",
    ]
    assert [result.detected_call_count for result in all_results] == [1, 1]
    assert [result.detected_import_count for result in all_results] == [1, 1]
    assert alpha_result.definition.qualified_name == "src.alpha.save"
    assert alpha_result.detected_call_count == 1
    assert alpha_result.detected_import_count == 1


def test_code_search_reports_unresolved_same_name_calls_as_candidates(tmp_path: Path) -> None:
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

    results = build_search(tmp_path).search("save")

    assert [result.detected_call_count for result in results] == [0, 0]
    assert [result.candidate_call_count for result in results] == [1, 1]


def test_code_search_returns_empty_list_for_unknown_symbol(tmp_path: Path) -> None:
    write_file(tmp_path, "src/pricing.py", "def calculate_total() -> int:\n    return 0\n")

    assert build_search(tmp_path).search("missing_symbol") == []


@pytest.mark.parametrize("symbol", ["", "   "])
def test_code_search_rejects_empty_symbol(tmp_path: Path, symbol: str) -> None:
    write_file(tmp_path, "src/pricing.py", "def calculate_total() -> int:\n    return 0\n")

    with pytest.raises(ValueError, match="不能为空"):
        build_search(tmp_path).search(symbol)


@pytest.mark.asyncio
async def test_code_search_maps_text_hits_to_enclosing_and_called_symbols(
    tmp_path: Path,
) -> None:
    write_file(
        tmp_path,
        "src/pricing.py",
        "def calculate_total(subtotal: float, discount: float) -> float:\n"
        "    return subtotal - discount\n",
    )
    write_file(
        tmp_path,
        "tests/test_pricing.py",
        "from src.pricing import calculate_total\n\n"
        "def test_zero_discount() -> None:\n"
        "    assert calculate_total(100.0, discount=0) == 100.0\n",
    )

    response = await build_search(tmp_path).search_text("discount")

    assert response.query == "discount"
    assert response.results[0].definition.qualified_name == "src.pricing.calculate_total"
    assert response.results[0].reason == "rg 命中测试文件中的调用"
    assert response.results[0].score == 0.80
    assert response.results[0].text_match_count == 3
    assert response.results[0].detected_test_count == 1
    assert not response.truncated


@pytest.mark.asyncio
async def test_code_search_deduplicates_exact_symbol_and_rg_hits(tmp_path: Path) -> None:
    write_file(
        tmp_path,
        "src/pricing.py",
        "def calculate_total() -> int:\n    return 0\n",
    )
    write_file(
        tmp_path,
        "src/order.py",
        "from src.pricing import calculate_total\n\ndef create_order() -> int:\n"
        "    return calculate_total()\n",
    )

    response = await build_search(tmp_path).search_text("calculate_total")
    matching_results = [
        result
        for result in response.results
        if result.definition.qualified_name == "src.pricing.calculate_total"
    ]

    assert len(matching_results) == 1
    assert matching_results[0].score == 1.0
    assert matching_results[0].reason == "精确函数定义"
    assert matching_results[0].text_match_count == 3


@pytest.mark.asyncio
async def test_code_search_reports_truncated_rg_results(tmp_path: Path) -> None:
    write_file(
        tmp_path,
        "src/pricing.py",
        "def calculate_total() -> int:\n    marker = 1\n    marker += 1\n    return marker\n",
    )

    response = await build_search(tmp_path).search_text("marker", max_results=1)

    assert response.truncated
    assert response.results[0].definition.qualified_name == "src.pricing.calculate_total"
    assert response.results[0].text_match_count == 1


@pytest.mark.asyncio
async def test_code_search_includes_indexing_errors_in_text_response(tmp_path: Path) -> None:
    write_file(tmp_path, "src/broken.py", "def broken(:\n")
    write_file(tmp_path, "src/pricing.py", "def healthy() -> int:\n    return 1\n")

    response = await build_search(tmp_path).search_text("healthy")

    assert response.results[0].definition.qualified_name == "src.pricing.healthy"
    assert [(error.path, error.error_type) for error in response.indexing_errors] == [
        ("src/broken.py", "SYNTAX_ERROR")
    ]
