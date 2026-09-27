"""桌面端本地长期记忆：SQLite 存储与关键词检索（不需要 Embedding 服务）。"""

from pathlib import Path

import pytest
from bit_agent.memory import (
    ConsolidationStatus,
    MemoryCandidate,
    MemoryConsolidator,
    MemoryKind,
    MemoryRecord,
    MemoryRetriever,
    MemoryScope,
    MemorySourceReference,
    SQLiteLongTermMemoryStore,
    VerifiedRunEvidence,
    WorkingMemory,
)
from bit_agent.memory.chunking import MemoryChunker, MemoryChunkingPolicy
from bit_agent.memory.keywords import keyword_tokens

PROJECT = "d:/work/calculator"


def candidate(key: str, title: str, content: str, **extra) -> MemoryCandidate:
    return MemoryCandidate(
        kind=extra.pop("kind", MemoryKind.PROCEDURE),
        memory_key=key,
        title=title,
        content=content,
        applicability=extra.pop("applicability", "本项目的代码修改任务"),
        evidence_summary="独立验收通过",
        tags=extra.pop("tags", []),
        importance=0.8,
        confidence=0.9,
        **extra,
    )


def record(key: str, title: str, content: str, *, project: str | None = PROJECT, **extra):
    item = candidate(key, title, content, **extra)
    scope = extra.get("scope", MemoryScope.PROJECT)
    return MemoryRecord.from_candidate(
        item,
        source_run_id="run-1",
        project_id=project if scope is MemoryScope.PROJECT else None,
        user_id=None,
    )


@pytest.fixture
def store(tmp_path: Path):
    value = SQLiteLongTermMemoryStore(tmp_path / "memory.sqlite3")
    yield value
    value.close()


def test_keyword_tokens_split_chinese_into_pairs_and_drop_noise() -> None:
    assert keyword_tokens("修复测试失败") == ["修复", "复测", "测试", "试失", "失败"]
    assert keyword_tokens("运行的测试") == ["运行", "测试"]  # 含“的”的片段不要
    assert keyword_tokens("Run the Pytest suite in Docker") == ["run", "pytest", "suite", "docker"]
    assert keyword_tokens("改 bug") == ["bug", "改"]


async def test_two_character_chinese_word_is_found(store) -> None:
    await store.save(
        record(
            "project.testing.docker",
            "测试必须在 Docker 中运行",
            "本项目的单元测试依赖 Docker 沙箱。",
        )
    )
    matches = await store.search(
        [], query_text="怎么跑测试", project_id=PROJECT, lexical_weight=1.0
    )
    assert [match.memory.memory_key for match in matches] == ["project.testing.docker"]
    assert matches[0].matched_by == ["lexical"]


async def test_results_are_scoped_to_the_project(store) -> None:
    await store.save(record("project.build.uv", "依赖用 uv 安装", "安装依赖使用 uv sync。"))
    await store.save(
        record("project.build.uv", "依赖用 uv 安装", "安装依赖使用 uv sync。", project="d:/other")
    )
    matches = await store.search([], query_text="安装依赖", project_id=PROJECT, lexical_weight=1.0)
    assert [match.memory.project_id for match in matches] == [PROJECT]
    assert (
        await store.search([], query_text="安装依赖", project_id="d:/none", lexical_weight=1.0)
        == []
    )


async def test_title_match_ranks_above_body_match(store) -> None:
    await store.save(record("project.a", "日志配置说明", "迁移时要注意数据库的备份。"))
    await store.save(record("project.b", "数据库迁移步骤", "先停止服务，再执行脚本。"))
    matches = await store.search(
        [], query_text="数据库迁移", project_id=PROJECT, lexical_weight=1.0
    )
    assert [match.memory.memory_key for match in matches][0] == "project.b"


async def test_find_by_key_update_and_delete(store, tmp_path: Path) -> None:
    original = record("project.lint.ruff", "提交前运行 Ruff", "修改 Python 文件后运行 ruff check。")
    await store.save(original)
    found = await store.find_by_key(
        scope=MemoryScope.PROJECT, memory_key="project.lint.ruff", project_id=PROJECT, user_id=None
    )
    assert found == original
    await store.save(original.model_copy(update={"tags": ["lint"]}))
    assert [item.tags for item in await store.list_memories(PROJECT)] == [["lint"]]

    assert await store.delete(original.id) is True
    assert await store.list_memories(PROJECT) == []
    assert await store.search([], query_text="Ruff", project_id=PROJECT, lexical_weight=1.0) == []
    assert (
        await store.find_by_key(
            scope=MemoryScope.PROJECT,
            memory_key="project.lint.ruff",
            project_id=PROJECT,
            user_id=None,
        )
        is None
    )
    assert await store.delete(original.id) is False


async def test_data_survives_reopening(tmp_path: Path) -> None:
    path = tmp_path / "memory.sqlite3"
    first = SQLiteLongTermMemoryStore(path)
    await first.save(
        record("project.release", "发布前更新版本号", "修改 pyproject 里的 version 字段。")
    )
    first.close()
    second = SQLiteLongTermMemoryStore(path)
    try:
        matches = await second.search(
            [], query_text="发布版本", project_id=PROJECT, lexical_weight=1.0
        )
        assert [match.memory.memory_key for match in matches] == ["project.release"]
    finally:
        second.close()


async def test_long_memory_is_searched_through_its_chunks(store) -> None:
    long_text = "。".join(f"第{index}步：检查配置项并记录结果" for index in range(200))
    chunker = MemoryChunker(
        MemoryChunkingPolicy(chunk_threshold_tokens=300, max_chunk_tokens=200, overlap_tokens=20)
    )
    root, records = chunker.build_records(
        candidate("project.release.checklist", "发布检查清单", long_text, kind=MemoryKind.EPISODE),
        source_run_id="run-1",
        project_id=PROJECT,
        user_id=None,
        source_reference=MemorySourceReference(run_id="run-1", evidence_hash="0" * 64),
    )
    assert len(records) > 2
    await store.save_many(records)
    matches = await store.search(
        [], query_text="检查配置项", project_id=PROJECT, limit=50, lexical_weight=1.0
    )
    assert matches and all(match.memory.parent_memory_id == root.id for match in matches)
    assert [item.id for item in await store.list_memories(PROJECT)] == [root.id]
    assert await store.delete(root.id)
    assert (
        await store.search([], query_text="检查配置项", project_id=PROJECT, lexical_weight=1.0)
        == []
    )


async def test_retriever_without_embedding_injects_only_relevant_memories(store) -> None:
    await store.save(
        record(
            "project.testing.docker",
            "测试必须在 Docker 中运行",
            "本项目的单元测试依赖 Docker 沙箱。",
        )
    )
    await store.save(record("project.docs.style", "文档用中文书写", "说明文档统一使用简体中文。"))
    retriever = MemoryRetriever(store)

    context = await retriever.build_context("修复失败的单元测试", project_id=PROJECT)
    assert "project.testing.docker" in context.text
    assert "project.docs.style" not in context.text

    unrelated = await retriever.build_context("帮我写一首诗", project_id=PROJECT)
    assert unrelated.text == "" and unrelated.matches == []


async def test_consolidated_memories_are_recalled_without_embeddings(store) -> None:
    class StaticExtractor:
        async def extract(self, evidence):
            return [
                candidate(
                    "project.testing.docker",
                    "测试必须在 Docker 中运行",
                    "本项目的单元测试依赖 Docker 沙箱，直接在本机运行会缺少依赖。",
                )
            ]

    evidence = VerifiedRunEvidence(
        run_id="run-9",
        thread_id="session-1",
        project_id=PROJECT,
        objective="修复单元测试",
        working_memory=WorkingMemory(thread_id="session-1", objective="修复单元测试"),
        independently_verified=True,
    )
    result = await MemoryConsolidator(StaticExtractor(), store).consolidate(evidence)
    assert result.status is ConsolidationStatus.COMPLETED
    assert len(result.created) == 1 and result.created[0].embedding is None

    context = await MemoryRetriever(store).build_context("单元测试又失败了", project_id=PROJECT)
    assert "Docker" in context.text
