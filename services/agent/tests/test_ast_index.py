from pathlib import Path

from bit_agent.context import generate_repo_map
from bit_agent.context.ast_index import PythonAstIndex
from bit_agent.models.code_index import (
    ImportBinding,
    IndexingError,
    ReferenceResolution,
    ReferenceType,
    SymbolDefinition,
    SymbolKind,
)


def write_file(root: Path, relative: str, content: str) -> None:
    target = root.joinpath(*relative.split("/"))
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def build_index(tmp_path: Path) -> PythonAstIndex:
    repo_map = generate_repo_map(tmp_path)
    index = PythonAstIndex()
    index.build(tmp_path, repo_map)
    return index


def test_ast_index_finds_function_async_class_and_method(tmp_path: Path) -> None:
    write_file(
        tmp_path,
        "src/payment.py",
        "def calculate_total() -> int:\n"
        "    return 0\n\n"
        "async def fetch_user() -> dict:\n"
        "    return {}\n\n"
        "class PaymentService:\n"
        "    def refund(self) -> None:\n"
        "        pass\n",
    )

    index = build_index(tmp_path)

    assert index.find_definitions("calculate_total")[0].kind is SymbolKind.FUNCTION
    assert index.find_definitions("fetch_user")[0].kind is SymbolKind.ASYNC_FUNCTION
    assert index.find_definitions("PaymentService")[0].kind is SymbolKind.CLASS
    assert index.find_definitions("refund") == [
        SymbolDefinition(
            name="refund",
            qualified_name="src.payment.PaymentService.refund",
            kind=SymbolKind.METHOD,
            path="src/payment.py",
            line=8,
            end_line=9,
        )
    ]


def test_ast_index_resolves_local_direct_call_and_caller(tmp_path: Path) -> None:
    write_file(
        tmp_path,
        "src/pricing.py",
        "def calculate_total() -> int:\n"
        "    return 0\n\n"
        "def create_order() -> int:\n"
        "    return calculate_total()\n",
    )

    reference = build_index(tmp_path).find_references("calculate_total")[0]

    assert reference.path == "src/pricing.py"
    assert reference.line == 5
    assert reference.end_line == 5
    assert reference.reference_type is ReferenceType.DIRECT_CALL
    assert reference.caller_qualified_name == "src.pricing.create_order"
    assert reference.expression == "calculate_total"
    assert reference.receiver is None
    assert reference.callee_qualified_name == "src.pricing.calculate_total"
    assert reference.candidate_qualified_names == []
    assert reference.resolution is ReferenceResolution.RESOLVED


def test_ast_index_resolves_from_import_alias_call(tmp_path: Path) -> None:
    write_file(tmp_path, "src/pricing.py", "def calculate_total() -> int:\n    return 0\n")
    write_file(
        tmp_path,
        "src/order.py",
        "from src.pricing import calculate_total as calc\n\n"
        "def create_order() -> int:\n"
        "    return calc()\n",
    )

    index = build_index(tmp_path)
    reference = index.find_references("src.pricing.calculate_total")[0]

    assert reference.name == "calculate_total"
    assert reference.expression == "calc"
    assert reference.reference_type is ReferenceType.ALIAS_CALL
    assert reference.caller_qualified_name == "src.order.create_order"
    assert reference.callee_qualified_name == "src.pricing.calculate_total"
    assert reference.resolution is ReferenceResolution.RESOLVED
    assert index.find_references("calc") == []
    assert index.find_imports("src.pricing.calculate_total") == [
        ImportBinding(
            path="src/order.py",
            module="src.pricing",
            imported_name="calculate_total",
            alias="calc",
            local_name="calc",
            target_qualified_name="src.pricing.calculate_total",
            line=1,
        )
    ]


def test_ast_index_resolves_module_alias_attribute_call(tmp_path: Path) -> None:
    write_file(tmp_path, "src/pricing.py", "def calculate_total() -> int:\n    return 0\n")
    write_file(
        tmp_path,
        "src/order.py",
        "import src.pricing as pricing\n\n"
        "def create_order() -> int:\n"
        "    return pricing.calculate_total()\n",
    )

    index = build_index(tmp_path)
    reference = index.find_references("src.pricing.calculate_total")[0]

    assert reference.reference_type is ReferenceType.ATTRIBUTE_CALL
    assert reference.expression == "pricing.calculate_total"
    assert reference.receiver == "pricing"
    assert reference.callee_qualified_name == "src.pricing.calculate_total"
    assert index.find_imports("src.pricing") == [
        ImportBinding(
            path="src/order.py",
            module="src.pricing",
            alias="pricing",
            local_name="pricing",
            target_qualified_name="src.pricing",
            line=1,
        )
    ]


def test_ast_index_resolves_typed_receiver_to_method(tmp_path: Path) -> None:
    write_file(
        tmp_path,
        "src/payment.py",
        "class PaymentService:\n    def refund(self) -> None:\n        pass\n",
    )
    write_file(
        tmp_path,
        "src/order.py",
        "from src.payment import PaymentService\n\n"
        "def refund_order(service: PaymentService) -> None:\n"
        "    service.refund()\n",
    )

    reference = build_index(tmp_path).find_references("src.payment.PaymentService.refund")[0]

    assert reference.caller_qualified_name == "src.order.refund_order"
    assert reference.receiver == "service"
    assert reference.callee_qualified_name == "src.payment.PaymentService.refund"
    assert reference.resolution is ReferenceResolution.RESOLVED


def test_ast_index_resolves_constructed_receiver_to_method(tmp_path: Path) -> None:
    write_file(
        tmp_path,
        "src/payment.py",
        "class PaymentService:\n    def refund(self) -> None:\n        pass\n",
    )
    write_file(
        tmp_path,
        "src/order.py",
        "from src.payment import PaymentService\n\n"
        "def refund_order() -> None:\n"
        "    service = PaymentService()\n"
        "    service.refund()\n",
    )

    reference = build_index(tmp_path).find_references("src.payment.PaymentService.refund")[0]

    assert reference.line == 5
    assert reference.receiver == "service"
    assert reference.callee_qualified_name == "src.payment.PaymentService.refund"


def test_ast_index_resolves_self_method_call(tmp_path: Path) -> None:
    write_file(
        tmp_path,
        "src/payment.py",
        "class PaymentService:\n"
        "    def process(self) -> None:\n"
        "        self.refund()\n\n"
        "    def refund(self) -> None:\n"
        "        pass\n",
    )

    reference = build_index(tmp_path).find_references("src.payment.PaymentService.refund")[0]

    assert reference.caller_qualified_name == "src.payment.PaymentService.process"
    assert reference.receiver == "self"
    assert reference.callee_qualified_name == "src.payment.PaymentService.refund"


def test_ast_index_resolves_instance_attribute_created_in_init(tmp_path: Path) -> None:
    write_file(
        tmp_path,
        "src/payment.py",
        "class Gateway:\n"
        "    def charge(self) -> None:\n"
        "        pass\n\n"
        "class PaymentService:\n"
        "    def __init__(self) -> None:\n"
        "        self.gateway = Gateway()\n\n"
        "    def process(self) -> None:\n"
        "        self.gateway.charge()\n",
    )

    reference = build_index(tmp_path).find_references("src.payment.Gateway.charge")[0]

    assert reference.caller_qualified_name == "src.payment.PaymentService.process"
    assert reference.receiver == "self.gateway"
    assert reference.callee_qualified_name == "src.payment.Gateway.charge"


def test_ast_index_keeps_untyped_attribute_call_as_named_candidates(tmp_path: Path) -> None:
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

    reference = build_index(tmp_path).find_references("save")[0]

    assert reference.callee_qualified_name is None
    assert reference.receiver == "service"
    assert reference.candidate_qualified_names == [
        "src.items.Alpha.save",
        "src.items.Beta.save",
    ]
    assert reference.resolution is ReferenceResolution.CANDIDATE


def test_ast_index_resolves_relative_import(tmp_path: Path) -> None:
    write_file(tmp_path, "src/pkg/pricing.py", "def calculate_total() -> int:\n    return 0\n")
    write_file(
        tmp_path,
        "src/pkg/order.py",
        "from .pricing import calculate_total\n\n"
        "def create_order() -> int:\n"
        "    return calculate_total()\n",
    )

    index = build_index(tmp_path)

    assert index.find_imports("src.pkg.pricing.calculate_total")[0].module == "src.pkg.pricing"
    assert (
        index.find_references("src.pkg.pricing.calculate_total")[0].callee_qualified_name
        == "src.pkg.pricing.calculate_total"
    )


def test_ast_index_resolves_local_callable_alias(tmp_path: Path) -> None:
    write_file(tmp_path, "src/pricing.py", "def calculate_total() -> int:\n    return 0\n")
    write_file(
        tmp_path,
        "src/order.py",
        "from src.pricing import calculate_total\n\n"
        "def create_order() -> int:\n"
        "    calc = calculate_total\n"
        "    return calc()\n",
    )

    references = build_index(tmp_path).find_references("src.pricing.calculate_total")

    assert len(references) == 1
    assert references[0].expression == "calc"
    assert references[0].reference_type is ReferenceType.ALIAS_CALL


def test_ast_index_continues_after_syntax_and_decode_errors(tmp_path: Path) -> None:
    write_file(tmp_path, "src/broken.py", "def broken(:\n    pass\n")
    write_file(tmp_path, "src/good.py", "def healthy() -> None:\n    pass\n")
    invalid_file = tmp_path / "src" / "invalid.py"
    invalid_file.write_bytes(b"\xff\xfe\x00")

    index = build_index(tmp_path)

    assert index.find_definitions("healthy")
    errors = index.get_errors()
    assert len(errors) == 2
    assert all(isinstance(error, IndexingError) for error in errors)
    assert [(error.path, error.error_type) for error in errors] == [
        ("src/broken.py", "SYNTAX_ERROR"),
        ("src/invalid.py", "DECODE_ERROR"),
    ]


def test_ast_index_sorts_duplicate_definitions_stably(tmp_path: Path) -> None:
    write_file(tmp_path, "src/zeta.py", "def save() -> None:\n    pass\n")
    write_file(tmp_path, "src/alpha.py", "def save() -> None:\n    pass\n")
    repo_map = generate_repo_map(tmp_path)
    reversed_repo_map = repo_map.model_copy(update={"tree": list(reversed(repo_map.tree))})
    index = PythonAstIndex()

    index.build(tmp_path, reversed_repo_map)

    assert [definition.qualified_name for definition in index.find_definitions("save")] == [
        "src.alpha.save",
        "src.zeta.save",
    ]
