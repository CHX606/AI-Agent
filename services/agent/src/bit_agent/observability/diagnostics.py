"""Operational diagnostics only; business events remain in the existing SQLite event store."""

import contextvars
import errno
import json
import logging
import os
import re
import time
import traceback
from contextlib import contextmanager
from datetime import UTC, datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any
from uuid import uuid4

FIELDS = set(
    """session_id task_id tool_call_id run_id agent_id diagnostic_id request_id
provider_request_id operation event status status_code error_code error_type error_description
duration_ms retry_count timeout_ms phase phase_since last_activity elapsed_ms streamed bytes
exit_code signal reason method route frames count dropped available cause_type rpc_id event_id
sequence timestamp terminal source""".split()
)
_context: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar(
    "diagnostic", default=None
)
_secrets: set[str] = set()
_logger = logging.getLogger("bit_agent.diagnostics")
_logger.addHandler(logging.NullHandler())
_logger.propagate = False
_logger.setLevel(logging.INFO)


def logging_available() -> bool:
    return any(isinstance(handler, SafeRotatingHandler) and handler.available
               for handler in _logger.handlers)


def register_secret(value: str) -> None:
    if len(value) >= 4:
        _secrets.add(value)


def redact(value: str) -> str:
    for secret in [
        *_secrets,
        *(v for k, v in os.environ.items() if re.search(r"key|token|secret|password", k, re.I)),
    ]:
        if len(secret) >= 4:
            value = value.replace(secret, "[REDACTED]")
    value = re.sub(r"Bearer\s+\S+|\bsk-[\w-]+", "[REDACTED]", value, flags=re.I)
    value = re.sub(r"https?://\S+|[A-Z]:[\\/]\S+", "[LOCATION]", value, flags=re.I)
    value = re.sub(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "[EMAIL]", value)
    value = re.sub(
        r"(?:api[_-]?key|authorization|password|token)\s*[=:]\s*[^\s,;}]+",
        "[REDACTED]",
        value,
        flags=re.I,
    )
    return value[:512]


def safe_fields(values: dict[str, Any]) -> dict[str, Any]:
    return {
        k: redact(v) if isinstance(v, str) else v
        for k, v in values.items()
        if k in FIELDS and (v is None or isinstance(v, str | int | float | bool))
    }


@contextmanager
def diagnostic_context(**values: Any):
    token = _context.set({**(_context.get() or {}), **safe_fields(values)})
    try:
        yield
    finally:
        _context.reset(token)


def record(level: str, event: str, **fields: Any) -> None:
    try:
        _logger.log(
            getattr(logging, level.upper(), logging.INFO),
            event,
            extra={"diagnostic": safe_fields({**(_context.get() or {}), **fields, "event": event})},
        )
    except Exception:
        pass  # A diagnostic sink must never replace a business exception.


def diagnostic_id(error: BaseException | None = None) -> str:
    previous = getattr(error, "diagnostic_id", "")
    if re.fullmatch(r"D-[a-f0-9]{16}", previous):
        return previous
    value = f"D-{uuid4().hex[:16]}"
    if error is not None:
        try:
            error.diagnostic_id = value
        except Exception:
            pass
    return value


def public_error(identifier: str, message: str = "操作未完成，请查看日志与诊断") -> str:
    return f"{message}（诊断编号：{identifier}）"


def failure(event: str, error: BaseException, *, level: str = "error", **fields: Any) -> str:
    identifier = diagnostic_id(error)
    frames = "; ".join(
        f"{Path(f.filename).name}:{f.lineno}:{f.name}"
        for f in traceback.extract_tb(error.__traceback__)[-10:]
    )
    record(
        level,
        event,
        **{
            **fields,
            "diagnostic_id": identifier,
            "error_type": type(error).__name__,
            "frames": frames,
            "cause_type": type(error.__cause__).__name__ if error.__cause__ else None,
            "error_code": getattr(error, "sqlite_errorname", None) or getattr(error, "code", None)
            or errno.errorcode.get(getattr(error, "errno", None)) or fields.get("error_code"),
        },
    )
    return identifier


class SafeRotatingHandler(RotatingFileHandler):
    """Size rotation is stdlib; age cleanup only touches this handler's own files."""

    def __init__(self, path: Path, *, max_bytes: int, retention_days: float, backups: int):
        self.retention_seconds = retention_days * 86400
        self.available = True
        self.last_prune = 0.0
        super().__init__(path, maxBytes=max_bytes, backupCount=backups, encoding="utf-8")

    def handleError(self, record: logging.LogRecord) -> None:
        self.available = False

    def emit(self, record: logging.LogRecord) -> None:
        try:
            if time.time() - self.last_prune >= 60:
                self.last_prune = time.time()
                for file in Path(self.baseFilename).parent.glob("current.jsonl*"):
                    if not re.fullmatch(r"current\.jsonl(?:\.\d+)?", file.name):
                        continue
                    if file.is_symlink() or not file.is_file():
                        continue
                    if time.time() - file.stat().st_mtime > self.retention_seconds:
                        if str(file) == self.baseFilename:
                            if self.stream:
                                self.stream.close()
                                self.stream = None
                        file.unlink()
            super().emit(record)
        except Exception:
            self.available = False


class JsonFormatter(logging.Formatter):
    def format(self, item: logging.LogRecord) -> str:
        return json.dumps(
            {
                "time": datetime.now(UTC).isoformat(),
                "level": item.levelname,
                "process": "python",
                "pid": os.getpid(),
                "version": os.getenv("BIT_AGENT_VERSION", "0.1.0"),
                "session_id": None,
                "task_id": None,
                "tool_call_id": None,
                **getattr(item, "diagnostic", {}),
            },
            ensure_ascii=False,
        )


def configure_logging(
    directory: Path,
    *,
    max_bytes: int = 4 * 1024 * 1024,
    retention_days: float = 7,
    backups: int = 3,
) -> SafeRotatingHandler | None:
    for handler in _logger.handlers[:]:
        _logger.removeHandler(handler)
        handler.close()
    # SDK debug logging may contain HTTP bodies. The typed adapter is our only model log source.
    for name in ("openai", "openai.agents", "httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.CRITICAL)
    try:
        path = directory / "python"
        path.mkdir(parents=True, exist_ok=True)
        handler = SafeRotatingHandler(
            path / "current.jsonl",
            max_bytes=max_bytes,
            retention_days=retention_days,
            backups=backups,
        )
        handler.setFormatter(JsonFormatter())
        _logger.addHandler(handler)
        return handler
    except Exception:
        _logger.addHandler(logging.NullHandler())
        return None
