"""可序列化、可复现的仓库地图模型。"""

from pydantic import BaseModel, ConfigDict, Field


class RepoMap(BaseModel):
    """RepoMap 第一版的稳定输出结构。"""

    model_config = ConfigDict(frozen=True)

    root_name: str = Field(min_length=1)
    total_files: int = Field(ge=0)
    languages: dict[str, int]
    entry_files: list[str]
    test_files: list[str]
    manifests: list[str]
    tree: list[str]
    max_depth: int = Field(ge=0)
    truncated: bool = False
