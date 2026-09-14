"""PostgreSQL + pgvector 长期记忆存储。"""

import asyncio #导入异步 I/O 库，用于异步操作
import math #导入数学库
from collections.abc import Iterator, Sequence #导入抽象基类 Iterator 和 Sequence，用于类型注解
from contextlib import contextmanager #导入上下文管理器装饰器，用于创建上下文管理器
from typing import Any #导入 Any 类型，用于表示任意类型的值

from bit_agent.memory.models import ( #导入内存模型，用于表示长期记忆的结构和属性
    EmbeddingProfile, #这个类表示嵌入向量的提供者、模型、维度和版本等信息
    MemoryMatch, #这个类表示内存匹配结果，包括匹配的内存记录、相似度评分和匹配方式等信息
    MemoryRecord, #这个类表示长期记忆的基本单元，包括其元数据和内容
    MemoryScope, #这个类表示内存的作用域，可以是全局、项目或用户级别
)
from bit_agent.memory.store import ( #导入内存存储相关的协议和工具函数
    LongTermMemoryStore, #这个协议定义了长期记忆存储的接口，包括初始化、查找、保存和搜索等方法
    cosine_similarity, #计算两个向量的余弦相似度
    encode_json, #将 Python 对象编码为 JSON 字符串
    lexical_similarity, #计算两个文本的词汇相似度
)


class PostgreSQLLongTermMemoryStore(LongTermMemoryStore): #这个类实现了 LongTermMemoryStore 协议，使用 PostgreSQL 数据库和 pgvector 扩展来存储和检索长期记忆记录。
    def __init__(self, dsn: str, *, table_name: str = "bit_agent_memories") -> None: #初始化 PostgreSQL 长期记忆存储，接受数据库连接字符串和可选的表名参数。
        '''保存连接配置、表名'''
        if not dsn.strip(): #如果数据库连接字符串为空或仅包含空白字符，则抛出 ValueError 异常，提示 PostgreSQL DSN 不能为空。
            raise ValueError("PostgreSQL DSN 不能为空")
        if not table_name.replace("_", "").isalnum(): #如果表名不符合字母、数字和下划线的规则，则抛出 ValueError 异常，提示表名只能包含字母、数字和下划线。
            raise ValueError("table_name 只能包含字母、数字和下划线")
        self.dsn = dsn #self.dsn是数据库连接字符串，用于连接 PostgreSQL 数据库。dsn是一个字符串，包含数据库的主机、端口、用户名、密码和数据库名等信息。
        self.table_name = table_name #self.table_name是存储长期记忆记录的表名，用于在数据库中创建和查询表。table_name是一个字符串，默认值为"bit_agent_memories"。

    async def initialize(self) -> None: #这个函数是一个异步方法，用于初始化 PostgreSQL 长期记忆存储，包括创建表和索引等操作。它会在后台线程中执行同步的初始化逻辑，以避免阻塞事件循环。
        '''初始化数据库、创建表和索引'''
        await asyncio.to_thread(self._initialize_sync)

    def _initialize_sync(self) -> None: #这个函数是一个同步方法，用于执行实际的初始化逻辑，包括创建表和索引等操作。它会在一个数据库连接上下文中执行 SQL 语句，以确保数据库的结构符合长期记忆存储的要求。
        with self._connection() as connection: #self._connection()是一个上下文管理器，用于创建和管理数据库连接。它会在进入上下文时建立连接，并在退出上下文时关闭连接。connection是一个数据库连接对象，用于执行 SQL 语句和事务。
            connection.execute("CREATE EXTENSION IF NOT EXISTS vector") #执行 SQL 语句，创建 pgvector 扩展，如果已经存在则忽略。pgvector 扩展提供了向量数据类型和相似度搜索功能，用于存储和检索嵌入向量。
            connection.execute( #执行 SQL 语句，创建长期记忆表，如果已经存在则忽略。表的结构包括 id、scope、kind、memory_key、title、content、applicability、evidence_summary、tags、importance、confidence、project_id、user_id、source_run_ids、source_references、parent_memory_id、chunk_index、chunk_count、content_hash、embedding、embedding_provider、embedding_model、embedding_dimensions、embedding_version、status、created_at 和 updated_at 等字段。
                f"""
                CREATE TABLE IF NOT EXISTS {self.table_name} (
                    id TEXT PRIMARY KEY,
                    scope TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    memory_key TEXT NOT NULL,
                    title TEXT NOT NULL,
                    content TEXT NOT NULL,
                    applicability TEXT NOT NULL,
                    evidence_summary TEXT NOT NULL,
                    tags JSONB NOT NULL DEFAULT '[]'::jsonb,
                    importance DOUBLE PRECISION NOT NULL,
                    confidence DOUBLE PRECISION NOT NULL,
                    project_id TEXT,
                    user_id TEXT,
                    source_run_ids JSONB NOT NULL,
                    source_references JSONB NOT NULL DEFAULT '[]'::jsonb,
                    parent_memory_id TEXT,
                    chunk_index INTEGER NOT NULL DEFAULT 0,
                    chunk_count INTEGER NOT NULL DEFAULT 1,
                    content_hash TEXT,
                    embedding vector,
                    embedding_provider TEXT,
                    embedding_model TEXT,
                    embedding_dimensions INTEGER,
                    embedding_version TEXT,
                    status TEXT NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL,
                    updated_at TIMESTAMPTZ NOT NULL
                )
                """
            )
            migrations = ( #这个是一个元组，包含了需要添加到长期记忆表中的新字段定义。每个定义都是一个字符串，表示一个 SQL 列定义，包括列名、数据类型和约束条件等。这个元组用于在初始化时执行 ALTER TABLE 语句，以确保表结构符合最新的要求。
                "source_references JSONB NOT NULL DEFAULT '[]'::jsonb",
                "parent_memory_id TEXT",
                "chunk_index INTEGER NOT NULL DEFAULT 0",
                "chunk_count INTEGER NOT NULL DEFAULT 1",
                "content_hash TEXT",
                "embedding_provider TEXT",
                "embedding_model TEXT",
                "embedding_dimensions INTEGER",
                "embedding_version TEXT",
            )
            for definition in migrations: #遍历 migrations 元组中的每个字段定义，执行 ALTER TABLE 语句，将新字段添加到长期记忆表中。如果字段已经存在，则忽略该操作。
                connection.execute( #执行 ALTER TABLE 语句，将新字段添加到长期记忆表中。
                    f"ALTER TABLE {self.table_name} ADD COLUMN IF NOT EXISTS {definition}" #执行 SQL 语句，向长期记忆表中添加新字段，如果已经存在则忽略。definition 是一个字符串，表示一个 SQL 列定义，包括列名、数据类型和约束条件等。
                )
            connection.execute( #执行 SQL 语句，创建索引 lookup_idx，用于加速按作用域、内存键、项目 ID、用户 ID 和状态查询长期记忆记录的操作。如果索引已经存在，则忽略该操作。
                f"""
                CREATE INDEX IF NOT EXISTS {self.table_name}_lookup_idx
                ON {self.table_name} (scope, memory_key, project_id, user_id, status)
                """
            )
            connection.execute( #执行 SQL 语句，创建索引 profile_idx，用于加速按嵌入向量提供者、模型、维度、版本和状态查询长期记忆记录的操作。如果索引已经存在，则忽略该操作。
                f"""
                CREATE INDEX IF NOT EXISTS {self.table_name}_profile_idx
                ON {self.table_name} (
                    embedding_provider, embedding_model,
                    embedding_dimensions, embedding_version, status
                )
                """
            )

    async def find_by_key( #这个函数是一个异步方法，用于根据作用域、内存键、项目 ID 和用户 ID 查找长期记忆记录。它会在后台线程中执行同步的查找逻辑，以避免阻塞事件循环。
        #按业务键精确查找记忆
        self,
        *,
        scope: MemoryScope,
        memory_key: str,
        project_id: str | None,
        user_id: str | None,
    ) -> MemoryRecord | None:
        return await asyncio.to_thread( #在后台线程中执行同步的查找逻辑，以避免阻塞事件循环。
            self._find_by_key_sync,
            scope,
            memory_key,
            project_id,
            user_id,
        )

    def _find_by_key_sync( #这个函数是一个同步方法，用于执行实际的查找逻辑，包括在数据库中查询长期记忆记录。它会在一个数据库连接上下文中执行 SQL 语句，以确保查询操作的正确性和效率。
        self,
        scope: MemoryScope,
        memory_key: str,
        project_id: str | None,
        user_id: str | None,
    ) -> MemoryRecord | None:
        with self._connection() as connection: #self._connection()是一个上下文管理器，用于创建和管理数据库连接。它会在进入上下文时建立连接，并在退出上下文时关闭连接。connection是一个数据库连接对象，用于执行 SQL 语句和事务。
            cursor = connection.execute(
                f"""
                SELECT * FROM {self.table_name}
                WHERE scope = %s
                  AND memory_key = %s
                  AND project_id IS NOT DISTINCT FROM %s
                  AND user_id IS NOT DISTINCT FROM %s
                  AND parent_memory_id IS NULL
                  AND status = 'ACTIVE'
                ORDER BY updated_at DESC, id
                LIMIT 1
                """,
                (scope.value, memory_key, project_id, user_id),
            )
            row = cursor.fetchone()
        return self._row_to_memory(row) if row is not None else None

    async def save(self, memory: MemoryRecord) -> None:
        '''保存单条记忆'''
        await self.save_many([memory])

    async def save_many(self, memories: Sequence[MemoryRecord]) -> None:
        '''批量保存记忆'''
        if not memories:
            return
        await asyncio.to_thread(self._save_many_sync, list(memories))

    def _save_many_sync(self, memories: Sequence[MemoryRecord]) -> None:
        with self._connection() as connection:
            for memory in memories:
                embedding = (
                    _vector_literal(memory.embedding)
                    if memory.embedding is not None
                    else None
                )
                profile = memory.embedding_profile
                connection.execute(
                    f"""
                    INSERT INTO {self.table_name} (
                        id, scope, kind, memory_key, title, content, applicability,
                        evidence_summary, tags, importance, confidence, project_id,
                        user_id, source_run_ids, source_references, parent_memory_id,
                        chunk_index, chunk_count, content_hash, embedding,
                        embedding_provider, embedding_model, embedding_dimensions,
                        embedding_version, status, created_at, updated_at
                    ) VALUES (
                        %s, %s, %s, %s, %s, %s, %s,
                        %s, %s::jsonb, %s, %s, %s,
                        %s, %s::jsonb, %s::jsonb, %s,
                        %s, %s, %s, %s::vector,
                        %s, %s, %s, %s, %s, %s, %s
                    )
                    ON CONFLICT (id) DO UPDATE SET
                        scope = EXCLUDED.scope,
                        kind = EXCLUDED.kind,
                        memory_key = EXCLUDED.memory_key,
                        title = EXCLUDED.title,
                        content = EXCLUDED.content,
                        applicability = EXCLUDED.applicability,
                        evidence_summary = EXCLUDED.evidence_summary,
                        tags = EXCLUDED.tags,
                        importance = EXCLUDED.importance,
                        confidence = EXCLUDED.confidence,
                        project_id = EXCLUDED.project_id,
                        user_id = EXCLUDED.user_id,
                        source_run_ids = EXCLUDED.source_run_ids,
                        source_references = EXCLUDED.source_references,
                        parent_memory_id = EXCLUDED.parent_memory_id,
                        chunk_index = EXCLUDED.chunk_index,
                        chunk_count = EXCLUDED.chunk_count,
                        content_hash = EXCLUDED.content_hash,
                        embedding = EXCLUDED.embedding,
                        embedding_provider = EXCLUDED.embedding_provider,
                        embedding_model = EXCLUDED.embedding_model,
                        embedding_dimensions = EXCLUDED.embedding_dimensions,
                        embedding_version = EXCLUDED.embedding_version,
                        status = EXCLUDED.status,
                        updated_at = EXCLUDED.updated_at
                    """,
                    (
                        memory.id,
                        memory.scope.value,
                        memory.kind.value,
                        memory.memory_key,
                        memory.title,
                        memory.content,
                        memory.applicability,
                        memory.evidence_summary,
                        encode_json(memory.tags),
                        memory.importance,
                        memory.confidence,
                        memory.project_id,
                        memory.user_id,
                        encode_json(memory.source_run_ids),
                        encode_json(
                            [
                                reference.model_dump(mode="json")
                                for reference in memory.source_references
                            ]
                        ),
                        memory.parent_memory_id,
                        memory.chunk_index,
                        memory.chunk_count,
                        memory.content_hash,
                        embedding,
                        profile.provider if profile is not None else None,
                        profile.model if profile is not None else None,
                        profile.dimensions if profile is not None else None,
                        profile.version if profile is not None else None,
                        memory.status.value,
                        memory.created_at,
                        memory.updated_at,
                    ),
                )

    async def search(
        #搜索相关记忆
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
        if limit <= 0:
            raise ValueError("limit 必须大于 0")
        if semantic_weight + lexical_weight <= 0:
            raise ValueError("语义与关键词权重不能同时为 0")
        return await asyncio.to_thread(
            self._search_sync,
            embedding,
            query_text,
            embedding_profile,
            project_id,
            user_id,
            limit,
            semantic_weight,
            lexical_weight,
        )

    def _search_sync(
        self,
        embedding: Sequence[float],
        query_text: str | None,
        embedding_profile: EmbeddingProfile | None,
        project_id: str | None,
        user_id: str | None,
        limit: int,
        semantic_weight: float,
        lexical_weight: float,
    ) -> list[MemoryMatch]:
        vector = _vector_literal(embedding)
        profile = embedding_profile
        lexical_pattern = f"%{(query_text or '').strip()}%"
        pool_size = max(limit, min(200, limit * 2))
        common_parameters = (
            project_id,
            user_id,
            profile.provider if profile is not None else None,
            profile.provider if profile is not None else None,
            profile.model if profile is not None else None,
            profile.dimensions if profile is not None else None,
            profile.version if profile is not None else None,
        )
        with self._connection() as connection:
            semantic_cursor = connection.execute(
                f"""
                SELECT *, 1 - (embedding <=> %s::vector) AS semantic_similarity
                FROM {self.table_name}
                WHERE status = 'ACTIVE'
                  AND embedding IS NOT NULL
                  AND (
                    scope = 'GLOBAL'
                    OR (scope = 'PROJECT' AND project_id IS NOT DISTINCT FROM %s)
                    OR (scope = 'USER' AND user_id IS NOT DISTINCT FROM %s)
                  )
                  AND (
                    %s::text IS NULL
                    OR (
                      embedding_provider = %s
                      AND embedding_model = %s
                      AND embedding_dimensions = %s
                      AND embedding_version = %s
                    )
                  )
                  AND vector_dims(embedding) = %s
                ORDER BY embedding <=> %s::vector, id
                LIMIT %s
                """,
                (
                    vector,
                    *common_parameters,
                    len(embedding),
                    vector,
                    pool_size,
                ),
            )
            rows_by_id = {row["id"]: row for row in semantic_cursor.fetchall()}
            if query_text and query_text.strip() and lexical_weight > 0:
                lexical_cursor = connection.execute(
                    f"""
                    SELECT *
                    FROM {self.table_name}
                    WHERE status = 'ACTIVE'
                      AND embedding IS NOT NULL
                      AND (
                        scope = 'GLOBAL'
                        OR (scope = 'PROJECT' AND project_id IS NOT DISTINCT FROM %s)
                        OR (scope = 'USER' AND user_id IS NOT DISTINCT FROM %s)
                      )
                      AND (
                        %s::text IS NULL
                        OR (
                          embedding_provider = %s
                          AND embedding_model = %s
                          AND embedding_dimensions = %s
                          AND embedding_version = %s
                        )
                      )
                      AND vector_dims(embedding) = %s
                      AND (
                        memory_key ILIKE %s
                        OR title ILIKE %s
                        OR content ILIKE %s
                        OR tags::text ILIKE %s
                      )
                    ORDER BY importance DESC, confidence DESC, id
                    LIMIT %s
                    """,
                    (
                        *common_parameters,
                        len(embedding),
                        lexical_pattern,
                        lexical_pattern,
                        lexical_pattern,
                        lexical_pattern,
                        pool_size,
                    ),
                )
                for row in lexical_cursor.fetchall():
                    rows_by_id.setdefault(row["id"], row)

        weight_total = semantic_weight + lexical_weight
        matches: list[MemoryMatch] = []
        for row in rows_by_id.values():
            memory = self._row_to_memory(row)
            semantic = cosine_similarity(embedding, memory.embedding or [])
            lexical = lexical_similarity(query_text or "", memory)
            combined = (
                semantic * semantic_weight + lexical * lexical_weight
            ) / weight_total
            matched_by = ["semantic"]
            if lexical > 0:
                matched_by.append("lexical")
            matches.append(
                MemoryMatch(
                    memory=memory,
                    similarity=max(-1.0, min(1.0, combined)),
                    semantic_similarity=semantic,
                    lexical_similarity=lexical,
                    matched_by=matched_by,
                )
            )
        return sorted(
            matches,
            key=lambda match: (-match.similarity, match.memory.id),
        )[:limit]

    @contextmanager
    def _connection(self) -> Iterator[Any]:
        '''管理数据库连接'''
        try:
            import psycopg
            from psycopg.rows import dict_row
        except ImportError as exc:
            raise RuntimeError(
                "使用 PostgreSQLLongTermMemoryStore 需要安装 memory 可选依赖"
            ) from exc

        connection = psycopg.connect(self.dsn, row_factory=dict_row)
        try:
            with connection.transaction():
                yield connection
        finally:
            connection.close()

    @staticmethod
    def _row_to_memory(row: Any) -> MemoryRecord:
        '''数据库记录转成记忆对象'''
        data = dict(row)
        data.pop("similarity", None)
        data.pop("semantic_similarity", None)
        data["embedding"] = _parse_vector(data.get("embedding"))
        provider = data.pop("embedding_provider", None)
        model = data.pop("embedding_model", None)
        dimensions = data.pop("embedding_dimensions", None)
        version = data.pop("embedding_version", None)
        if provider is not None:
            data["embedding_profile"] = {
                "provider": provider,
                "model": model,
                "dimensions": dimensions,
                "version": version,
            }
        elif data["embedding"] is not None:
            data["embedding_profile"] = {
                "provider": "legacy",
                "model": "unknown",
                "dimensions": len(data["embedding"]),
                "version": "1",
            }
        return MemoryRecord.model_validate(data)


def _vector_literal(values: Sequence[float]) -> str:
    '''向量转成数据库需要的文本'''
    if not values:
        raise ValueError("Embedding 不能为空")
    normalized = [float(value) for value in values]
    if any(not math.isfinite(value) for value in normalized):
        raise ValueError("Embedding 只能包含有限浮点数")
    return "[" + ",".join(format(value, ".17g") for value in normalized) + "]"


def _parse_vector(value: Any) -> list[float] | None:
    '''数据库向量转回数字列表'''
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        return [float(item) for item in value]
    text = str(value).strip()
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
    if not text:
        return []
    return [float(item) for item in text.split(",")]
