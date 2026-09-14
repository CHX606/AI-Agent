"""探测 OpenAI 兼容中转站实际支持的 Embedding 模型与延迟。"""

import argparse
import json
from time import perf_counter

from bit_agent.memory import EmbeddingSettings


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "models",
        nargs="*",
        default=[],
    )
    parser.add_argument("--timeout", type=float, default=30.0)
    return parser.parse_args()


def main() -> int:
    arguments = parse_args()
    settings = EmbeddingSettings.from_environment().model_copy(
        update={"request_timeout_seconds": arguments.timeout, "max_retries": 0}
    )
    client = settings.create_client()
    models = arguments.models or [settings.model]
    results: list[dict[str, object]] = []

    for model in models:
        started_at = perf_counter()
        try:
            response = client.embeddings.create(
                model=model,
                input=[
                    "代码修改完成后需要运行隔离测试。",
                    "Docker 测试通过后才能结束代码修改任务。",
                ],
                dimensions=settings.dimensions,
            )
        except Exception as exc:
            results.append(
                {
                    "model": model,
                    "success": False,
                    "latency_ms": round((perf_counter() - started_at) * 1_000),
                    "error_type": type(exc).__name__,
                    "status_code": getattr(exc, "status_code", None),
                }
            )
            continue

        ordered = sorted(response.data, key=lambda item: item.index)
        dimensions = {len(item.embedding) for item in ordered}
        results.append(
            {
                "model": model,
                "returned_model": response.model,
                "success": True,
                "latency_ms": round((perf_counter() - started_at) * 1_000),
                "vector_count": len(ordered),
                "dimensions": sorted(dimensions),
                "input_tokens": getattr(response.usage, "prompt_tokens", None),
            }
        )

    print(json.dumps({"results": results}, ensure_ascii=False, indent=2))
    return 0 if any(result["success"] for result in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
