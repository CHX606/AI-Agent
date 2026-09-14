"""把 AST 索引中的符号事实整理为紧凑的候选摘要。"""

from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from bit_agent.context.ast_index import PythonAstIndex
from bit_agent.context.snippets import TRUNCATION_MARKER, extract_snippet
from bit_agent.models.code_index import (
    CodeSearchResponse,
    CodeSearchResult,
    ReferenceType,
    SymbolDefinition,
    SymbolKind,
)
from bit_agent.security.paths import resolve_workspace_path
from bit_agent.tools.context import ToolContext
from bit_agent.tools.models import ToolStatus
from bit_agent.tools.search_code import search_code as rg_search_code

DEFINITION_REASONS = {
    SymbolKind.FUNCTION: "精确函数定义",
    SymbolKind.ASYNC_FUNCTION: "精确异步函数定义",
    SymbolKind.CLASS: "精确类定义",
    SymbolKind.METHOD: "精确方法定义",
}


def is_test_path(relative_path: str) -> bool:
    path = PurePosixPath(relative_path)
    parts = {part.casefold() for part in path.parts[:-1]}
    stem = path.stem.casefold()
    return "tests" in parts or "test" in parts or stem.startswith("test_") or stem.endswith("_test")


@dataclass(slots=True)
class _CandidateEvidence:
    definition: SymbolDefinition
    reason: str
    score: float
    locations: set[tuple[str, int]] = field(default_factory=set)


def _parse_rg_output(output: str) -> list[tuple[str, int]]:
    hits: list[tuple[str, int]] = []
    for raw_line in output.splitlines():
        parts = raw_line.split(":", 3)
        if len(parts) != 4:
            continue
        path, line_text, _column_text, _matched_text = parts
        try:
            line = int(line_text)
        except ValueError:
            continue
        hits.append((path.replace("\\", "/"), line))
    return hits


class CodeSearch:
    """根据已构建的 AST 索引生成按定义分组的候选摘要。"""

    def __init__(self, workspace_root: Path, ast_index: PythonAstIndex) -> None:
        if not isinstance(workspace_root, Path):
            raise TypeError("workspace_root 必须是 Path 对象")
        if not isinstance(ast_index, PythonAstIndex):
            raise TypeError("ast_index 是必须 PythonAstIndex 对象")

        self._workspace_root = workspace_root
        self._ast_index = ast_index

    def _build_result(
        self,
        definition: SymbolDefinition,
        *,
        reason: str,
        score: float,
        text_match_count: int = 0,
    ) -> CodeSearchResult:
        related_references = self._ast_index.find_references(definition.qualified_name)
        resolved_calls = [
            reference
            for reference in related_references
            if reference.callee_qualified_name == definition.qualified_name
        ]
        candidate_calls = [
            reference
            for reference in related_references
            if definition.qualified_name in reference.candidate_qualified_names
        ]
        related_imports = self._ast_index.find_related_imports(definition.qualified_name)
        test_paths = {
            record.path
            for record in [*resolved_calls, *related_imports]
            if is_test_path(record.path)
        }

        absolute_path = resolve_workspace_path(self._workspace_root, definition.path)
        snippet = extract_snippet(
            absolute_path,
            definition.line,
            definition.end_line,
        )
        return CodeSearchResult(
            definition=definition,
            snippet=snippet,
            reason=reason,
            score=score,
            detected_call_count=len(resolved_calls),
            candidate_call_count=len(candidate_calls),
            detected_import_count=len(related_imports),
            detected_test_count=len(test_paths),
            text_match_count=text_match_count,
            truncated=TRUNCATION_MARKER in snippet,
        )

    @staticmethod
    def _sort_results(results: list[CodeSearchResult]) -> list[CodeSearchResult]:
        return sorted(
            results,
            key=lambda result: (
                -result.score,
                result.definition.path,
                result.definition.line,
                result.definition.qualified_name,
            ),
        )

    def search(self, symbol: str) -> list[CodeSearchResult]:
        if not isinstance(symbol, str):
            raise TypeError("symbol 必须是字符串")

        normalized_symbol = symbol.strip()
        if not normalized_symbol:
            raise ValueError("symbol 不能为空")

        definitions = self._ast_index.find_definitions(normalized_symbol)
        return self._sort_results(
            [
                self._build_result(
                    definition,
                    reason=DEFINITION_REASONS[definition.kind],
                    score=1.0,
                )
                for definition in definitions
            ]
        )

    @staticmethod
    def _add_evidence(
        evidence_by_name: dict[str, _CandidateEvidence],
        definition: SymbolDefinition,
        *,
        reason: str,
        score: float,
        location: tuple[str, int] | None = None,
    ) -> None:
        current = evidence_by_name.get(definition.qualified_name)
        if current is None:
            current = _CandidateEvidence(definition=definition, reason=reason, score=score)
            evidence_by_name[definition.qualified_name] = current
        elif score > current.score:
            current.reason = reason
            current.score = score
        if location is not None:
            current.locations.add(location)

    async def search_text(self, query: str, *, max_results: int = 50) -> CodeSearchResponse:
        if not isinstance(query, str):
            raise TypeError("query 必须是字符串")
        normalized_query = query.strip()
        if not normalized_query:
            raise ValueError("query 不能为空")

        tool_result = await rg_search_code(
            ToolContext(self._workspace_root, "context_code_search"),
            normalized_query,
            glob="*.py",
            max_results=max_results,
        )
        partial_result = bool(
            tool_result.error
            and tool_result.error.code in {"RESULT_LIMIT_EXCEEDED", "OUTPUT_LIMIT_EXCEEDED"}
            and isinstance(tool_result.output, str)
        )
        if tool_result.status is not ToolStatus.SUCCESS and not partial_result:
            message = tool_result.error.message if tool_result.error else "rg 搜索失败"
            raise RuntimeError(message)

        evidence_by_name: dict[str, _CandidateEvidence] = {}
        for exact_result in self.search(normalized_query):
            self._add_evidence(
                evidence_by_name,
                exact_result.definition,
                reason=exact_result.reason,
                score=exact_result.score,
            )

        output = tool_result.output if isinstance(tool_result.output, str) else ""
        for path, line in _parse_rg_output(output):
            location = (path, line)
            enclosing = self._ast_index.find_enclosing_definition(path, line)
            if enclosing:
                self._add_evidence(
                    evidence_by_name,
                    enclosing,
                    reason="rg 文本命中函数或类的代码范围",
                    score=0.50,
                    location=location,
                )

            for reference in self._ast_index.find_references_at(path, line):
                if reference.callee_qualified_name:
                    definitions = self._ast_index.find_definitions(reference.callee_qualified_name)
                    if is_test_path(path):
                        reason, score = "rg 命中测试文件中的调用", 0.80
                    elif reference.reference_type in {
                        ReferenceType.DIRECT_CALL,
                        ReferenceType.ALIAS_CALL,
                    }:
                        reason, score = "rg 命中直接函数调用", 0.90
                    else:
                        reason, score = "rg 命中已解析的属性调用", 0.65
                    for definition in definitions:
                        self._add_evidence(
                            evidence_by_name,
                            definition,
                            reason=reason,
                            score=score,
                            location=location,
                        )

                for candidate_name in reference.candidate_qualified_names:
                    for definition in self._ast_index.find_definitions(candidate_name):
                        self._add_evidence(
                            evidence_by_name,
                            definition,
                            reason="rg 命中同名属性调用候选",
                            score=0.65,
                            location=location,
                        )

            for binding in self._ast_index.find_imports_at(path, line):
                for definition in self._ast_index.find_definitions(binding.target_qualified_name):
                    self._add_evidence(
                        evidence_by_name,
                        definition,
                        reason="rg 命中符号导入位置",
                        score=0.85,
                        location=location,
                    )

        results = [
            self._build_result(
                evidence.definition,
                reason=evidence.reason,
                score=evidence.score,
                text_match_count=len(evidence.locations),
            )
            for evidence in evidence_by_name.values()
        ]
        return CodeSearchResponse(
            query=normalized_query,
            results=self._sort_results(results),
            indexing_errors=self._ast_index.get_errors(),
            truncated=tool_result.metadata.truncated,
        )
