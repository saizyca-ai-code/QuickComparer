"""FastAPI 應用。

端點只有四組，對應 D001 對 server 的定義：檔案 bytes、metadata、專案設定。
解碼與合成完全不在這裡 —— 那是 client 端 GPU 的事，這條界線不能模糊，
一旦後端開始碰畫面，slider 的即時性就沒了。
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from dataclasses import asdict
from typing import Annotated

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import library, media, probe, store
from .paths import DATA_DIR, SERVICE_ROOT

log = logging.getLogger("quickcomparer")


@asynccontextmanager
async def lifespan(_: FastAPI):
    store.init_db()
    log.info("服務根目錄 %s，資料目錄 %s", SERVICE_ROOT, DATA_DIR)
    yield


app = FastAPI(title="QuickComparer 本機服務", version="0.1.0", lifespan=lifespan)

# 開發期前端由 vite 供應（另一個 port），正式打包後會同源。
# 只開放 localhost —— 這個服務會讀本機檔案，不該接受其他來源。
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^http://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["GET", "PUT"],
    allow_headers=["*"],
    expose_headers=["content-range", "accept-ranges", "content-length"],
)


# ---------------------------------------------------------------- 健康檢查


@app.get("/api/health")
def health() -> dict:
    """啟動確認。順便回報 ffprobe 是否就緒 —— 缺了它 metadata 就整組失效，
    要在使用者拖第一支素材之前就講清楚，而不是等到失敗才報錯。"""
    try:
        ffprobe = probe.ffprobe_path()
        ffprobe_error = None
    except probe.ProbeError as exc:
        ffprobe = None
        ffprobe_error = str(exc)

    return {
        "ok": True,
        "version": app.version,
        "ffprobe": ffprobe,
        "ffprobeError": ffprobe_error,
    }


# ---------------------------------------------------------------- 專案設定


class ProjectDirBody(BaseModel):
    path: str


@app.get("/api/project")
def get_project() -> dict:
    path = store.get_project_dir()
    return {
        "path": None if path is None else str(path),
        "exists": bool(path and path.is_dir()),
    }


@app.put("/api/project")
def put_project(body: ProjectDirBody) -> dict:
    try:
        resolved = library.set_project_dir(body.path)
    except library.ProjectError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"path": str(resolved), "exists": True}


@app.get("/api/media")
def list_media() -> dict:
    try:
        entries = library.list_media()
    except library.ProjectError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"items": [asdict(e) for e in entries]}


# ---------------------------------------------------------------- metadata


@app.get("/api/probe")
def probe_media(path: Annotated[str, Query(description="相對於專案資料夾的路徑")]) -> dict:
    try:
        resolved = library.resolve(path)
    except library.NotInProject as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except library.ProjectError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    if library.kind_of(resolved) == "image":
        # 圖片沒有時基，也沒有 keyframe 的概念。前端的 ImageFrameSource 本來就
        # 自己讀尺寸，這裡只回檔案層級的事實，不硬套視訊的欄位。
        stat = resolved.stat()
        return {
            "path": path,
            "kind": "image",
            "size": stat.st_size,
            "mime": library.mime_of(resolved),
        }

    try:
        info = probe.probe(resolved)
    except probe.ProbeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    payload = asdict(info)
    payload["path"] = path
    payload["kind"] = "video"
    payload["mime"] = library.mime_of(resolved)
    return payload


# ---------------------------------------------------------------- 檔案供應


@app.get("/api/file")
def get_file(
    path: Annotated[str, Query(description="相對於專案資料夾的路徑")],
    range_header: Annotated[str | None, Header(alias="range")] = None,
):
    try:
        resolved = library.resolve(path)
    except library.NotInProject as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except library.ProjectError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    return media.file_response(resolved, library.mime_of(resolved), range_header)
