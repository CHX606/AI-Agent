"""桌面端的长期记忆存储：本机一个 SQLite 文件，关键词检索，不需要数据库服务。

检索用 SQLite 自带的 FTS5 全文索引。中文先在 Python 里切成两字片段再写入索引
（见 keywords.py），因此两个字的词也能命中；排序用 FTS5 内置的 BM25。
记录里带 Embedding 时也支持语义检索，逻辑与内存版一致。
"""

import asyncio
import sqlite3
import threading
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from bit_agent.memory.keywords import (
    indexed_text,
    is_searchable,
    keyword_coverage,
    memory_fields,
    query_tokens,
)
from bit_agent.memory.models import (
    EmbeddingProfile,
    MemoryMatch,
    MemoryRecord,
    MemoryRecordStatus,
    MemoryScope,
)
from bit_agent.memory.store import cosine_similarity

# 列权重：记忆键和标题最能说明主题，其次是标签，正文最低。
_BM25_WEIGHTS = "0.0, 3.0, 3.0, 2.0, 1.0"
_SCOPE_FILTER = (
    "m.status = 'ACTIVE' AND (m.scope = 'GLOBAL'"
    " OR (m.scope = 'PROJECT' AND m.project_id IS ?)"
    " OR (m.scope = 'USER' AND m.user_id IS ?))"
)


class SQLiteLongTermMemoryStore:
    """实现 LongTermMemoryStore 协议，另外提供查看和删除，供管理界面使用。"""

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._lock = threading.RLock()
        self._db = sqlite3.connect(path, timeout=15, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                scope TEXT NOT NULL,
                memory_key TEXT NOT NULL,
                project_id TEXT,
                user_id TEXT,
                parent_memory_id TEXT,
                status TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                data TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS memories_lookup
                ON memories(scope, memory_key, project_id, user_id, status);
            CREATE INDEX IF NOT EXISTS memories_parent ON memories(parent_memory_id);
            CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
                memory_id UNINDEXED, keys, title, tags, body, tokenize = 'unicode61'
            );
            """
        )
        self._db.commit()

    # ---- LongTermMemoryStore ---------------------------------------------

    async def find_by_key(
        self,
        *,
        scope: MemoryScope,
        memory_key: str,
        project_id: str | None,
        user_id: str | None,
    ) -> MemoryRecord | None:
        row = await self._run(
            lambda: self._db.execute(
                "SELECT data FROM memories WHERE status = 'ACTIVE' AND parent_memory_id IS NULL"
                " AND scope = ? AND memory_key = ? AND project_id IS ? AND user_id IS ?",
                (scope.value, memory_key, project_id, user_id),
            ).fetchone()
        )
        return MemoryRecord.model_validate_json(row["data"]) if row else None

    async def save(self, memory: MemoryRecord) -> None:
        await self.save_many([memory])

    async def save_many(self, memories: Sequence[MemoryRecord]) -> None:
        def write() -> None:
            with self._db:
                for memory in memories:
                    self._upsert(memory)

        await self._run(write)

    async def search(
        self,
        embedding: Sequence[float],
        *,
        query_text: str | None = None,
        embedding_profile: EmbeddingProfile | None = None,
        project_id: str | None = None,
        user_id: str | None = None,
        limit: int = 5,
        semantic_weight: float = 1.0,
        lexical_weight: float = 0.0,
    ) -> list[MemoryMatch]:
        """embedding 为空或 semantic_weight 为 0 时只做关键词检索。"""
        if limit <= 0:
            raise ValueError("limit 必须大于 0")
        if semantic_weight + lexical_weight <= 0:
            raise ValueError("语义与关键词权重不能同时为 0")
        if not embedding or semantic_weight == 0:
            return await self._keyword_search(query_text or "", project_id, user_id, limit)
        return await self._semantic_search(
            embedding,
            query_text or "",
            embedding_profile,
            project_id,
            user_id,
            limit,
            semantic_weight,
            lexical_weight,
        )

    # ---- 管理 --------------------------------------------------------------

    async def list_memories(self, project_id: str | None = None) -> list[MemoryRecord]:
        """有效的记忆（不含长记忆拆出的分块），新的在前。"""
        sql = "SELECT data FROM memories WHERE status = 'ACTIVE' AND parent_memory_id IS NULL"
        params: tuple[Any, ...] = ()
        if project_id is not None:
            sql += " AND project_id IS ?"
            params = (project_id,)
        rows = await self._run(
            lambda: self._db.execute(sql + " ORDER BY updated_at DESC", params).fetchall()
        )
        return [MemoryRecord.model_validate_json(row["data"]) for row in rows]

    async def delete(self, memory_id: str) -> bool:
        """标记删除这条记忆及其分块，并移出检索索引；保留记录以便审计。"""

        def remove() -> bool:
            with self._db:
                rows = self._db.execute(
                    "SELECT data FROM memories WHERE (id = ? OR parent_memory_id = ?)"
                    " AND status = 'ACTIVE'",
                    (memory_id, memory_id),
                ).fetchall()
                for row in rows:
                    memory = MemoryRecord.model_validate_json(row["data"])
                    self._upsert(memory.model_copy(update={"status": MemoryRecordStatus.DELETED}))
                return bool(rows)

        return await self._run(remove)

    def close(self) -> None:
        with self._lock:
            self._db.close()

    # ---- 内部 --------------------------------------------------------------

    async def _run(self, operation):
        def locked():
            with self._lock:
                return operation()

        return await asyncio.to_thread(locked)

    def _upsert(self, memory: MemoryRecord) -> None:
        self._db.execute(
            "INSERT OR REPLACE INTO memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                memory.id,
                memory.scope.value,
                memory.memory_key,
                memory.project_id,
                memory.user_id,
                memory.parent_memory_id,
                memory.status.value,
                memory.updated_at.isoformat(),
                memory.model_dump_json(),
            ),
        )
        self._db.execute("DELETE FROM memories_fts WHERE memory_id = ?", (memory.id,))
        if memory.status is MemoryRecordStatus.ACTIVE and is_searchable(memory):
            fields = memory_fields(memory)
            self._db.execute(
                "INSERT INTO memories_fts VALUES (?, ?, ?, ?, ?)",
                (
                    memory.id,
                    *(indexed_text(fields[name]) for name in ("keys", "title", "tags", "body")),
                ),
            )

    async def _keyword_search(
        self, text: str, project_id: str | None, user_id: str | None, limit: int
    ) -> list[MemoryMatch]:
        tokens = query_tokens(text)
        if not tokens:
            return []
        # 每个关键词单独加引号，任意一个命中即可进入候选；排序交给 BM25。
        expression = " OR ".join('"' + token.replace('"', '""') + '"' for token in tokens)
        rows = await self._run(
            lambda: self._db.execute(
                f"SELECT m.data FROM memories_fts JOIN memories m ON m.id = memories_fts.memory_id"
                f" WHERE memories_fts MATCH ? AND {_SCOPE_FILTER}"
                f" ORDER BY bm25(memories_fts, {_BM25_WEIGHTS}) LIMIT ?",
                (expression, project_id, user_id, limit),
            ).fetchall()
        )
        matches = []
        for row in rows:
            memory = MemoryRecord.model_validate_json(row["data"])
            coverage = keyword_coverage(tokens, memory)
            matches.append(
                MemoryMatch(
                    memory=memory,
                    similarity=coverage,
                    lexical_similarity=coverage,
                    matched_by=["lexical"],
                )
            )
        return matches

    async def _semantic_search(
        self,
        embedding: Sequence[float],
        text: str,
        profile: EmbeddingProfile | None,
        project_id: str | None,
        user_id: str | None,
        limit: int,
        semantic_weight: float,
        lexical_weight: float,
    ) -> list[MemoryMatch]:
        rows = await self._run(
            lambda: self._db.execute(
                f"SELECT m.data FROM memories m WHERE {_SCOPE_FILTER}", (project_id, user_id)
            ).fetchall()
        )
        tokens = query_tokens(text)
        total = semantic_weight + lexical_weight
        matches = []
        for row in rows:
            memory = MemoryRecord.model_validate_json(row["data"])
            if memory.embedding is None or len(memory.embedding) != len(embedding):
                continue
            if profile is not None and memory.embedding_profile != profile:
                continue
            semantic = cosine_similarity(embedding, memory.embedding)
            lexical = keyword_coverage(tokens, memory)
            combined = (semantic * semantic_weight + lexical * lexical_weight) / total
            matches.append(
                MemoryMatch(
                    memory=memory,
                    similarity=max(-1.0, min(1.0, combined)),
                    semantic_similarity=semantic,
                    lexical_similarity=lexical,
                    matched_by=["semantic", "lexical"] if lexical > 0 else ["semantic"],
                )
            )
        return sorted(matches, key=lambda match: (-match.similarity, match.memory.id))[:limit]
