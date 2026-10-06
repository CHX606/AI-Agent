"""Read GIF block boundaries without interpreting image pixels or running image code."""


def _subblocks(data: bytes, offset: int) -> int:
    while offset < len(data):
        size = data[offset]
        offset += 1
        if not size:
            return offset
        offset += size
    raise ValueError("GIF 图片数据不完整")


def single_frame_gif(data: bytes) -> bool:
    if len(data) < 13:
        raise ValueError("GIF 图片数据不完整")
    offset = 13 + (3 * 2 ** ((data[10] & 7) + 1) if data[10] & 128 else 0)
    frames = 0
    while offset < len(data):
        kind = data[offset]
        offset += 1
        if kind == 59:
            return frames == 1
        if kind == 33:
            offset = _subblocks(data, offset + 1)
            continue
        if kind != 44 or offset + 9 > len(data):
            raise ValueError("GIF 图片数据不完整")
        flags = data[offset + 8]
        offset += 9 + (3 * 2 ** ((flags & 7) + 1) if flags & 128 else 0)
        offset = _subblocks(data, offset + 1)
        frames += 1
        if frames > 1:
            return False
    raise ValueError("GIF 图片数据不完整")
