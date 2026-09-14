from enum import StrEnum

from pydantic import BaseModel, Field


class SymbolKind(StrEnum):
    FUNCTION = "FUNCTION"
    ASYNC_FUNCTION = "ASYNC_FUNCTION"
    CLASS = "CLASS"
    METHOD = "METHOD"


class ReferenceType(StrEnum):
    DIRECT_CALL = "DIRECT_CALL"
    ATTRIBUTE_CALL = "ATTRIBUTE_CALL"
    ALIAS_CALL = "ALIAS_CALL"


class ReferenceResolution(StrEnum):
    RESOLVED = "RESOLVED"
    CANDIDATE = "CANDIDATE"
    UNRESOLVED = "UNRESOLVED"


class SymbolDefinition(BaseModel):
    name: str
    qualified_name: str
    kind: SymbolKind
    path: str
    line: int
    end_line: int


class SymbolReference(BaseModel):
    name: str
    path: str
    line: int
    end_line: int
    reference_type: ReferenceType
    caller_qualified_name: str
    expression: str
    receiver: str | None = None
    callee_qualified_name: str | None = None
    candidate_qualified_names: list[str] = Field(default_factory=list)
    resolution: ReferenceResolution


class ImportBinding(BaseModel):
    path: str
    module: str
    imported_name: str | None = None
    alias: str | None = None
    local_name: str
    target_qualified_name: str
    line: int


class IndexingError(BaseModel):
    path: str
    error_type: str
    message: str


class CodeSearchResult(BaseModel):
    definition: SymbolDefinition
    snippet: str
    reason: str
    score: float

    detected_call_count: int = 0
    candidate_call_count: int = 0
    detected_import_count: int = 0
    detected_test_count: int = 0
    text_match_count: int = 0

    truncated: bool = False


class CodeSearchResponse(BaseModel):
    query: str
    results: list[CodeSearchResult] = Field(default_factory=list)
    indexing_errors: list[IndexingError] = Field(default_factory=list)
    truncated: bool = False


class SymbolContext(BaseModel):
    candidate: CodeSearchResult
    resolved_references: list[SymbolReference] = Field(default_factory=list)
    candidate_references: list[SymbolReference] = Field(default_factory=list)
    imports: list[ImportBinding] = Field(default_factory=list)
    related_test_paths: list[str] = Field(default_factory=list)
