"""Bound subprocess output while preserving its beginning and end."""

MARKER = b"\n... output truncated ...\n"


class OutputBuffer:
    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.head = bytearray()
        self.tail = bytearray()
        self.total = 0

    def append(self, chunk: bytes) -> None:
        self.total += len(chunk)
        head_limit = self.limit // 2
        self.head.extend(chunk[: max(0, head_limit - len(self.head))])
        self.tail.extend(chunk)
        del self.tail[: max(0, len(self.tail) - (self.limit - head_limit))]

    def render(self) -> tuple[str, bool]:
        truncated = self.total > self.limit
        if not truncated:
            overlap = max(0, len(self.head) + len(self.tail) - self.total)
            data = bytes(self.head) + bytes(self.tail[overlap:])
            text = data.decode("utf-8", errors="replace")
            if len(text.encode("utf-8")) <= self.limit:
                return text, False
            data = text.encode("utf-8")
            truncated = True
            head_data, tail_data = data, data
        else:
            head_data, tail_data = bytes(self.head), bytes(self.tail)
        if self.limit <= len(MARKER):
            return head_data[: self.limit].decode("utf-8", errors="ignore"), True
        budget = self.limit - len(MARKER)
        head, tail = budget // 2, budget - budget // 2
        rendered = (
            head_data[:head].decode("utf-8", errors="ignore")
            + MARKER.decode("ascii")
            + tail_data[-tail:].decode("utf-8", errors="ignore")
        )
        return rendered, truncated


async def drain(stream, output: OutputBuffer) -> None:
    while chunk := await stream.read(8192):
        output.append(chunk)
