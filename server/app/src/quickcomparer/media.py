"""Byte-range 檔案供應。

自己實作而不是交給 FileResponse：byte-range 正是這個端點存在的理由（D001 把
server 定義為「只提供檔案 bytes 與 metadata」的薄層），行為必須明確可測，
不能依賴框架版本之間對 Range 的支援差異。

只處理單一 range。多重 range 在這個用途沒有意義，明確拒絕比回一個
半正確的 multipart 好。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Iterator

from fastapi import HTTPException
from fastapi.responses import StreamingResponse

#: 每次讀取的區塊大小。1 MiB 在本機檔案上足以攤平 syscall 成本，
#: 又不會讓單次讀取佔住事件迴圈太久。
CHUNK_SIZE = 1024 * 1024

_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


class InvalidRange(ValueError):
    pass


def parse_range(header: str, size: int) -> tuple[int, int]:
    """解析 Range 標頭，回傳含頭含尾的 [start, end]。

    支援三種形式：`bytes=0-499`、`bytes=500-`、`bytes=-500`（最後 500 bytes）。
    """
    match = _RANGE_RE.match(header.strip())
    if not match:
        raise InvalidRange(f"無法解析的 Range：{header}")

    raw_start, raw_end = match.group(1), match.group(2)

    if raw_start == "" and raw_end == "":
        raise InvalidRange("Range 沒有指定範圍")

    if raw_start == "":
        # 後綴形式：最後 N bytes。
        length = int(raw_end)
        if length <= 0:
            raise InvalidRange("後綴長度必須大於 0")
        start = max(0, size - length)
        end = size - 1
    else:
        start = int(raw_start)
        end = int(raw_end) if raw_end else size - 1
        end = min(end, size - 1)

    if start >= size or start > end:
        raise InvalidRange(f"範圍超出檔案大小：{header}（size={size}）")

    return start, end


def _iter_file(path: Path, start: int, end: int) -> Iterator[bytes]:
    remaining = end - start + 1
    with path.open("rb") as handle:
        handle.seek(start)
        while remaining > 0:
            chunk = handle.read(min(CHUNK_SIZE, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


def file_response(path: Path, mime: str, range_header: str | None) -> StreamingResponse:
    size = path.stat().st_size

    # Accept-Ranges 必須在兩種回應上都出現，否則客戶端無從得知可以續傳。
    headers = {
        "accept-ranges": "bytes",
        "content-disposition": f'inline; filename="{path.name}"',
        # 本機工具，素材可能隨時被外部工具覆寫，不要讓瀏覽器快取舊內容。
        "cache-control": "no-store",
    }

    if range_header is None:
        headers["content-length"] = str(size)
        return StreamingResponse(
            _iter_file(path, 0, size - 1) if size else iter(()),
            media_type=mime,
            headers=headers,
        )

    try:
        start, end = parse_range(range_header, size)
    except InvalidRange as exc:
        # 416 必須帶 Content-Range 告知實際大小，客戶端才知道該怎麼重試。
        raise HTTPException(
            status_code=416,
            detail=str(exc),
            headers={"content-range": f"bytes */{size}", "accept-ranges": "bytes"},
        ) from exc

    headers["content-range"] = f"bytes {start}-{end}/{size}"
    headers["content-length"] = str(end - start + 1)
    return StreamingResponse(
        _iter_file(path, start, end),
        status_code=206,
        media_type=mime,
        headers=headers,
    )
