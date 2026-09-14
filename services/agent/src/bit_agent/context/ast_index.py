"""Python AST 符号、导入和调用关系索引。"""

import ast
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from bit_agent.models.code_index import (
    ImportBinding,
    IndexingError,
    ReferenceResolution,
    ReferenceType,
    SymbolDefinition,
    SymbolKind,
    SymbolReference,
)
from bit_agent.models.repo_map import RepoMap
from bit_agent.security.paths import resolve_workspace_path


@dataclass(slots=True)
class _ParsedPythonFile:
    path: str
    module_name: str
    is_package: bool
    tree: ast.Module
    imports_by_node: dict[int, list[ImportBinding]] = field(default_factory=dict)


def _module_name(relative_path: str) -> tuple[str, bool]:
    path = PurePosixPath(relative_path)
    parts = list(path.with_suffix("").parts)
    is_package = bool(parts and parts[-1] == "__init__")
    if is_package:
        parts.pop()
    return ".".join(parts) or "__init__", is_package


def _resolve_import_module(
    current_module: str,
    is_package: bool,
    imported_module: str | None,
    level: int,
) -> str:
    if level == 0:
        return imported_module or ""

    package_parts = current_module.split(".") if is_package else current_module.split(".")[:-1]
    levels_up = level - 1
    if levels_up:
        package_parts = package_parts[:-levels_up] if levels_up <= len(package_parts) else []
    if imported_module:
        package_parts.extend(imported_module.split("."))
    return ".".join(package_parts)


def _import_bindings(
    node: ast.Import | ast.ImportFrom,
    parsed_file: _ParsedPythonFile,
) -> list[ImportBinding]:
    bindings: list[ImportBinding] = []
    if isinstance(node, ast.ImportFrom):
        module = _resolve_import_module(
            parsed_file.module_name,
            parsed_file.is_package,
            node.module,
            node.level,
        )
        for imported in node.names:
            if imported.name == "*":
                continue
            target = f"{module}.{imported.name}" if module else imported.name
            bindings.append(
                ImportBinding(
                    path=parsed_file.path,
                    module=module,
                    imported_name=imported.name,
                    alias=imported.asname,
                    local_name=imported.asname or imported.name,
                    target_qualified_name=target,
                    line=node.lineno,
                )
            )
        return bindings

    for imported in node.names:
        local_name = imported.asname or imported.name.split(".", 1)[0]
        bindings.append(
            ImportBinding(
                path=parsed_file.path,
                module=imported.name,
                alias=imported.asname,
                local_name=local_name,
                target_qualified_name=imported.name,
                line=node.lineno,
            )
        )
    return bindings


def _definition(
    node: ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef,
    qualified_name: str,
    kind: SymbolKind,
    relative_path: str,
) -> SymbolDefinition:
    return SymbolDefinition(
        name=node.name,
        qualified_name=qualified_name,
        kind=kind,
        path=relative_path,
        line=node.lineno,
        end_line=node.end_lineno or node.lineno,
    )


def _collect_definitions(parsed_file: _ParsedPythonFile) -> list[SymbolDefinition]:
    definitions: list[SymbolDefinition] = []
    for node in parsed_file.tree.body:
        if isinstance(node, ast.ClassDef):
            class_qualified_name = f"{parsed_file.module_name}.{node.name}"
            definitions.append(
                _definition(node, class_qualified_name, SymbolKind.CLASS, parsed_file.path)
            )
            for member in node.body:
                if isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    definitions.append(
                        _definition(
                            member,
                            f"{class_qualified_name}.{member.name}",
                            SymbolKind.METHOD,
                            parsed_file.path,
                        )
                    )
            continue

        if isinstance(node, ast.FunctionDef):
            definitions.append(
                _definition(
                    node,
                    f"{parsed_file.module_name}.{node.name}",
                    SymbolKind.FUNCTION,
                    parsed_file.path,
                )
            )
        elif isinstance(node, ast.AsyncFunctionDef):
            definitions.append(
                _definition(
                    node,
                    f"{parsed_file.module_name}.{node.name}",
                    SymbolKind.ASYNC_FUNCTION,
                    parsed_file.path,
                )
            )
    return definitions


class _ReferenceCollector(ast.NodeVisitor):
    def __init__(
        self,
        parsed_file: _ParsedPythonFile,
        definitions_by_name: dict[str, list[SymbolDefinition]],
        definitions_by_qualified_name: dict[str, SymbolDefinition],
        add_reference: Callable[[SymbolReference], None],
    ) -> None:
        self._parsed_file = parsed_file
        self._definitions_by_name = definitions_by_name
        self._definitions_by_qualified_name = definitions_by_qualified_name
        self._add_reference = add_reference
        self._caller_stack = [parsed_file.module_name]
        self._class_stack: list[str] = []
        self._import_scopes: list[dict[str, ImportBinding]] = [{}]
        self._variable_type_scopes: list[dict[str, str]] = [{}]
        self._callable_alias_scopes: list[dict[str, str]] = [{}]
        self._class_attribute_types: dict[str, dict[str, str]] = {}
        self._module_definitions = {
            definition.name: definition.qualified_name
            for definitions in definitions_by_name.values()
            for definition in definitions
            if definition.path == parsed_file.path and definition.kind is not SymbolKind.METHOD
        }
        for node in parsed_file.tree.body:
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                for binding in parsed_file.imports_by_node.get(id(node), []):
                    self._import_scopes[0][binding.local_name] = binding

    def _push_scope(self) -> None:
        self._import_scopes.append({})
        self._variable_type_scopes.append({})
        self._callable_alias_scopes.append({})

    def _pop_scope(self) -> None:
        self._import_scopes.pop()
        self._variable_type_scopes.pop()
        self._callable_alias_scopes.pop()

    def _lookup_import(self, name: str) -> ImportBinding | None:
        for scope in reversed(self._import_scopes):
            if name in scope:
                return scope[name]
        return None

    def _lookup_variable_type(self, name: str) -> str | None:
        for scope in reversed(self._variable_type_scopes):
            if name in scope:
                return scope[name]
        if self._class_stack:
            return self._class_attribute_types.get(self._class_stack[-1], {}).get(name)
        return None

    def _lookup_callable_alias(self, name: str) -> str | None:
        for scope in reversed(self._callable_alias_scopes):
            if name in scope:
                return scope[name]
        return None

    def _resolve_name(self, name: str) -> str | None:
        callable_alias = self._lookup_callable_alias(name)
        if callable_alias:
            return callable_alias
        binding = self._lookup_import(name)
        if binding:
            if binding.imported_name is None and binding.alias is None:
                return name
            return binding.target_qualified_name
        return self._module_definitions.get(name)

    def _extend_import_target(self, binding: ImportBinding, tail: list[str]) -> str:
        if binding.imported_name is not None or binding.alias is not None:
            return ".".join([binding.target_qualified_name, *tail])

        target_parts = binding.target_qualified_name.split(".")
        expected_prefix = target_parts[1:]
        if tail[: len(expected_prefix)] == expected_prefix:
            tail = tail[len(expected_prefix) :]
            return ".".join([binding.target_qualified_name, *tail])
        return ".".join([binding.local_name, *tail])

    def _resolve_attribute(self, node: ast.Attribute) -> str | None:
        receiver_expression = ast.unparse(node.value)
        receiver_type = self._lookup_variable_type(receiver_expression)
        if receiver_type:
            return f"{receiver_type}.{node.attr}"

        if isinstance(node.value, ast.Name) and node.value.id in {"self", "cls"}:
            if self._class_stack:
                return f"{self._class_stack[-1]}.{node.attr}"

        parts: list[str] = []
        current: ast.expr = node
        while isinstance(current, ast.Attribute):
            parts.append(current.attr)
            current = current.value
        if not isinstance(current, ast.Name):
            return None
        parts.append(current.id)
        parts.reverse()

        root = parts[0]
        binding = self._lookup_import(root)
        if binding:
            return self._extend_import_target(binding, parts[1:])

        base = self._resolve_name(root)
        if base:
            return ".".join([base, *parts[1:]])
        return None

    def _resolve_expression(self, node: ast.expr | None) -> str | None:
        if isinstance(node, ast.Name):
            return self._resolve_name(node.id)
        if isinstance(node, ast.Attribute):
            return self._resolve_attribute(node)
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            try:
                parsed = ast.parse(node.value, mode="eval")
            except SyntaxError:
                return None
            return self._resolve_expression(parsed.body)
        return None

    def _candidate_names(self, name: str, *, attribute_call: bool) -> list[str]:
        definitions = self._definitions_by_name.get(name, [])
        if attribute_call:
            methods = [
                definition for definition in definitions if definition.kind is SymbolKind.METHOD
            ]
            if methods:
                definitions = methods
        return sorted(definition.qualified_name for definition in definitions)

    def _record_call(self, node: ast.Call) -> None:
        expression = ast.unparse(node.func)
        receiver: str | None = None
        callee: str | None = None

        if isinstance(node.func, ast.Name):
            imported = self._lookup_import(node.func.id)
            alias_target = self._lookup_callable_alias(node.func.id)
            callee = self._resolve_name(node.func.id)
            name = callee.rsplit(".", 1)[-1] if callee else node.func.id
            is_alias = bool(
                alias_target
                or (
                    imported
                    and imported.local_name != imported.target_qualified_name.rsplit(".", 1)[-1]
                )
            )
            reference_type = ReferenceType.ALIAS_CALL if is_alias else ReferenceType.DIRECT_CALL
            candidates = [] if callee else self._candidate_names(name, attribute_call=False)
        elif isinstance(node.func, ast.Attribute):
            name = node.func.attr
            receiver = ast.unparse(node.func.value)
            callee = self._resolve_attribute(node.func)
            reference_type = ReferenceType.ATTRIBUTE_CALL
            candidates = [] if callee else self._candidate_names(name, attribute_call=True)
        else:
            return

        if callee:
            resolution = ReferenceResolution.RESOLVED
        elif candidates:
            resolution = ReferenceResolution.CANDIDATE
        else:
            resolution = ReferenceResolution.UNRESOLVED

        self._add_reference(
            SymbolReference(
                name=name,
                path=self._parsed_file.path,
                line=node.lineno,
                end_line=node.end_lineno or node.lineno,
                reference_type=reference_type,
                caller_qualified_name=self._caller_stack[-1],
                expression=expression,
                receiver=receiver,
                callee_qualified_name=callee,
                candidate_qualified_names=candidates,
                resolution=resolution,
            )
        )

    def _visit_function(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        for decorator in node.decorator_list:
            self.visit(decorator)
        for default in [*node.args.defaults, *node.args.kw_defaults]:
            if default is not None:
                self.visit(default)

        self._caller_stack.append(f"{self._caller_stack[-1]}.{node.name}")
        self._push_scope()

        arguments = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]
        if node.args.vararg:
            arguments.append(node.args.vararg)
        if node.args.kwarg:
            arguments.append(node.args.kwarg)
        for argument in arguments:
            qualified_type = self._resolve_expression(argument.annotation)
            if qualified_type:
                self._variable_type_scopes[-1][argument.arg] = qualified_type

        for statement in node.body:
            self.visit(statement)

        self._pop_scope()
        self._caller_stack.pop()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._visit_function(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._visit_function(node)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        for decorator in node.decorator_list:
            self.visit(decorator)
        for base in node.bases:
            self.visit(base)

        class_qualified_name = f"{self._caller_stack[-1]}.{node.name}"
        self._caller_stack.append(class_qualified_name)
        self._class_stack.append(class_qualified_name)
        self._class_attribute_types.setdefault(class_qualified_name, {})
        self._push_scope()
        for statement in node.body:
            self.visit(statement)
        self._pop_scope()
        self._class_stack.pop()
        self._caller_stack.pop()

    def visit_Import(self, node: ast.Import) -> None:
        for binding in self._parsed_file.imports_by_node.get(id(node), []):
            self._import_scopes[-1][binding.local_name] = binding

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        for binding in self._parsed_file.imports_by_node.get(id(node), []):
            self._import_scopes[-1][binding.local_name] = binding

    def _target_names(self, node: ast.expr) -> list[str]:
        if isinstance(node, ast.Name):
            return [node.id]
        if isinstance(node, ast.Attribute):
            return [ast.unparse(node)]
        if isinstance(node, (ast.Tuple, ast.List)):
            return [name for element in node.elts for name in self._target_names(element)]
        return []

    def _infer_constructed_type(self, value: ast.expr | None) -> str | None:
        if not isinstance(value, ast.Call):
            return None
        target = self._resolve_expression(value.func)
        if not target:
            return None
        definition = self._definitions_by_qualified_name.get(target)
        if definition and definition.kind is SymbolKind.CLASS:
            return target
        final_name = target.rsplit(".", 1)[-1]
        return target if final_name[:1].isupper() else None

    def _remember_assignment(
        self,
        targets: list[str],
        value: ast.expr | None,
        annotation: ast.expr | None = None,
    ) -> None:
        variable_type = self._resolve_expression(annotation)
        variable_type = self._infer_constructed_type(value) or variable_type
        callable_target = None
        if value is not None and not isinstance(value, ast.Call):
            callable_target = self._resolve_expression(value)

        for target in targets:
            if variable_type:
                self._variable_type_scopes[-1][target] = variable_type
                if self._class_stack:
                    class_attributes = self._class_attribute_types[self._class_stack[-1]]
                    if target.startswith(("self.", "cls.")):
                        class_attributes[target] = variable_type
                    elif self._caller_stack[-1] == self._class_stack[-1]:
                        class_attributes[f"self.{target}"] = variable_type
                        class_attributes[f"cls.{target}"] = variable_type
            if callable_target:
                self._callable_alias_scopes[-1][target] = callable_target

    def visit_Assign(self, node: ast.Assign) -> None:
        self.visit(node.value)
        targets = [name for target in node.targets for name in self._target_names(target)]
        self._remember_assignment(targets, node.value)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if node.value is not None:
            self.visit(node.value)
        self._remember_assignment(self._target_names(node.target), node.value, node.annotation)

    def visit_Call(self, node: ast.Call) -> None:
        self._record_call(node)
        self.generic_visit(node)


class PythonAstIndex:
    def __init__(self) -> None:
        self._definitions: dict[str, list[SymbolDefinition]] = {}
        self._definitions_by_qualified_name: dict[str, SymbolDefinition] = {}
        self._definitions_by_path: dict[str, list[SymbolDefinition]] = {}
        self._references: dict[str, list[SymbolReference]] = {}
        self._imports: dict[str, list[ImportBinding]] = {}
        self._all_imports: list[ImportBinding] = []
        self._errors: list[IndexingError] = []

    def _add_definition(self, definition: SymbolDefinition) -> None:
        self._definitions.setdefault(definition.name, []).append(definition)
        self._definitions_by_qualified_name[definition.qualified_name] = definition
        self._definitions_by_path.setdefault(definition.path, []).append(definition)

    def _add_import(self, binding: ImportBinding) -> None:
        key = binding.imported_name or binding.target_qualified_name
        self._imports.setdefault(key, []).append(binding)
        self._all_imports.append(binding)

    def _add_reference(self, reference: SymbolReference) -> None:
        self._references.setdefault(reference.name, []).append(reference)

    def build(self, workspace_root: Path, repo_map: RepoMap) -> None:
        self._definitions.clear()
        self._definitions_by_qualified_name.clear()
        self._definitions_by_path.clear()
        self._references.clear()
        self._imports.clear()
        self._all_imports.clear()
        self._errors.clear()

        parsed_files: list[_ParsedPythonFile] = []
        for relative_path in repo_map.tree:
            if not relative_path.endswith(".py"):
                continue

            absolute_path = resolve_workspace_path(workspace_root, relative_path)
            try:
                source = absolute_path.read_text(encoding="utf-8")
                tree = ast.parse(source, filename=relative_path)
            except UnicodeDecodeError as exc:
                self._errors.append(
                    IndexingError(
                        path=relative_path,
                        error_type="DECODE_ERROR",
                        message=str(exc),
                    )
                )
                continue
            except SyntaxError as exc:
                self._errors.append(
                    IndexingError(
                        path=relative_path,
                        error_type="SYNTAX_ERROR",
                        message=str(exc),
                    )
                )
                continue
            except OSError as exc:
                self._errors.append(
                    IndexingError(
                        path=relative_path,
                        error_type="FILE_READ_ERROR",
                        message=str(exc),
                    )
                )
                continue

            module_name, is_package = _module_name(relative_path)
            parsed_file = _ParsedPythonFile(
                path=relative_path,
                module_name=module_name,
                is_package=is_package,
                tree=tree,
            )
            parsed_files.append(parsed_file)

            for definition in _collect_definitions(parsed_file):
                self._add_definition(definition)

            for node in ast.walk(tree):
                if not isinstance(node, (ast.Import, ast.ImportFrom)):
                    continue
                bindings = _import_bindings(node, parsed_file)
                parsed_file.imports_by_node[id(node)] = bindings
                for binding in bindings:
                    self._add_import(binding)

        for parsed_file in parsed_files:
            collector = _ReferenceCollector(
                parsed_file,
                self._definitions,
                self._definitions_by_qualified_name,
                self._add_reference,
            )
            collector.visit(parsed_file.tree)

        self._sort_results()

    def _sort_results(self) -> None:
        for definitions in self._definitions.values():
            definitions.sort(
                key=lambda item: (
                    item.path,
                    item.line,
                    item.qualified_name,
                    item.kind.value,
                )
            )
        for definitions in self._definitions_by_path.values():
            definitions.sort(
                key=lambda item: (
                    item.line,
                    item.end_line,
                    item.qualified_name,
                )
            )

        for references in self._references.values():
            references.sort(
                key=lambda item: (
                    item.path,
                    item.line,
                    item.end_line,
                    item.caller_qualified_name,
                    item.expression,
                    item.callee_qualified_name or "",
                )
            )

        for imports in self._imports.values():
            imports.sort(
                key=lambda item: (
                    item.path,
                    item.line,
                    item.target_qualified_name,
                    item.local_name,
                )
            )
        self._all_imports.sort(
            key=lambda item: (
                item.path,
                item.line,
                item.target_qualified_name,
                item.local_name,
            )
        )
        self._errors.sort(key=lambda item: (item.path, item.error_type, item.message))

    def find_definitions(self, symbol: str) -> list[SymbolDefinition]:
        if "." in symbol:
            definition = self._definitions_by_qualified_name.get(symbol)
            return [definition] if definition else []
        return list(self._definitions.get(symbol, []))

    def find_references(self, symbol: str) -> list[SymbolReference]:
        simple_name = symbol.rsplit(".", 1)[-1]
        references = self._references.get(simple_name, [])
        if "." not in symbol:
            return list(references)
        return [
            reference
            for reference in references
            if reference.callee_qualified_name == symbol
            or symbol in reference.candidate_qualified_names
        ]

    def find_enclosing_definition(self, path: str, line: int) -> SymbolDefinition | None:
        matches = [
            definition
            for definition in self._definitions_by_path.get(path, [])
            if definition.line <= line <= definition.end_line
        ]
        if not matches:
            return None
        return min(
            matches,
            key=lambda definition: (
                definition.end_line - definition.line,
                -definition.line,
                definition.qualified_name,
            ),
        )

    def find_references_at(self, path: str, line: int) -> list[SymbolReference]:
        return sorted(
            (
                reference
                for references in self._references.values()
                for reference in references
                if reference.path == path and reference.line <= line <= reference.end_line
            ),
            key=lambda reference: (
                reference.line,
                reference.end_line,
                reference.expression,
            ),
        )

    def find_imports_at(self, path: str, line: int) -> list[ImportBinding]:
        return [
            binding
            for binding in self._all_imports
            if binding.path == path and binding.line == line
        ]

    def find_imports(self, symbol: str) -> list[ImportBinding]:
        if "." in symbol:
            return [
                binding for binding in self._all_imports if binding.target_qualified_name == symbol
            ]
        return list(self._imports.get(symbol, []))

    def find_related_imports(self, qualified_name: str) -> list[ImportBinding]:
        resolved_paths = {
            reference.path
            for reference in self.find_references(qualified_name)
            if reference.callee_qualified_name == qualified_name
        }
        return [
            binding
            for binding in self._all_imports
            if binding.target_qualified_name == qualified_name
            or (
                binding.path in resolved_paths
                and qualified_name.startswith(f"{binding.target_qualified_name}.")
            )
        ]

    def get_imports(self) -> list[ImportBinding]:
        return list(self._all_imports)

    def get_errors(self) -> list[IndexingError]:
        return list(self._errors)
