from bit_agent.models.code_index import CodeSearchResult, SymbolDefinition, SymbolKind


def test_code_search_result_contains_definition_and_usage_counts() -> None:
    definition = SymbolDefinition(
        name="calculate_total",
        qualified_name="src.pricing.calculate_total",
        kind=SymbolKind.FUNCTION,
        path="src/pricing.py",
        line=10,
        end_line=24,
    )

    result = CodeSearchResult(
        definition=definition,
        snippet="    10 | def calculate_total(...):",
        reason="与价格计算问题相关",
        score=0.92,
        detected_call_count=8,
        detected_import_count=3,
        detected_test_count=2,
    )

    assert result.definition == definition
    assert result.definition.kind is SymbolKind.FUNCTION
    assert result.detected_call_count == 8
    assert result.detected_import_count == 3
    assert result.detected_test_count == 2
    assert not result.truncated
