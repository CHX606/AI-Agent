"""展开一个已选中符号的完整静态关系。"""

from pathlib import Path

from bit_agent.context.ast_index import PythonAstIndex
from bit_agent.context.code_search import CodeSearch, is_test_path
from bit_agent.models.code_index import SymbolContext


class RelatedFiles:
    """把候选摘要展开为确定引用、候选引用、导入和测试路径。"""

    def __init__(self, workspace_root: Path, ast_index: PythonAstIndex) -> None:
        if not isinstance(workspace_root, Path):
            raise TypeError("workspace_root 必须是 Path 对象")
        if not isinstance(ast_index, PythonAstIndex):
            raise TypeError("ast_index 必须是 PythonAstIndex 对象")

        self._ast_index = ast_index
        self._code_search = CodeSearch(workspace_root, ast_index)

    def get_symbol_context(self, qualified_name: str) -> SymbolContext:
        if not isinstance(qualified_name, str):
            raise TypeError("qualified_name 必须是字符串")

        normalized_name = qualified_name.strip()
        if not normalized_name or "." not in normalized_name:
            raise ValueError("qualified_name 必须是完整限定名称")

        candidates = self._code_search.search(normalized_name)
        if not candidates:
            raise LookupError(f"没有找到符号：{normalized_name}")

        candidate = candidates[0]
        references = self._ast_index.find_references(normalized_name)
        resolved_references = [
            reference
            for reference in references
            if reference.callee_qualified_name == normalized_name
        ]
        candidate_references = [
            reference
            for reference in references
            if normalized_name in reference.candidate_qualified_names
        ]
        imports = self._ast_index.find_related_imports(normalized_name)
        related_test_paths = sorted(
            {
                record.path
                for record in [*resolved_references, *imports]
                if is_test_path(record.path)
            }
        )

        return SymbolContext(
            candidate=candidate,
            resolved_references=resolved_references,
            candidate_references=candidate_references,
            imports=imports,
            related_test_paths=related_test_paths,
        )
