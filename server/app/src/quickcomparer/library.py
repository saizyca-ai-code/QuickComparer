"""專案資料夾與路徑解析。

服務只供應專案資料夾底下的檔案。這不是為了防外部攻擊（工具跑在本機），
而是因為前端會把路徑當識別字串傳來傳去，沒有一個明確的根就無法判斷
「這個路徑指的是不是同一份素材」，Phase 3 的媒體庫指紋也無從建立。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from . import store

VIDEO_SUFFIXES = {".mp4", ".m4v", ".mov"}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
MEDIA_SUFFIXES = VIDEO_SUFFIXES | IMAGE_SUFFIXES

MIME_TYPES = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
}


class ProjectError(RuntimeError):
    pass


class NotInProject(ProjectError):
    pass


@dataclass
class MediaEntry:
    #: 相對於專案資料夾的 POSIX 路徑。前端一律用這個當識別。
    rel_path: str
    name: str
    size: int
    modified: float
    kind: str  # "video" | "image"


def project_dir() -> Path:
    path = store.get_project_dir()
    if path is None:
        raise ProjectError("尚未設定專案資料夾")
    if not path.is_dir():
        raise ProjectError(f"專案資料夾不存在：{path}")
    return path


def set_project_dir(raw: str) -> Path:
    path = Path(raw).expanduser()
    if not path.is_dir():
        raise ProjectError(f"不是資料夾或不存在：{path}")
    resolved = path.resolve()
    store.set_project_dir(resolved)
    return resolved


def resolve(rel_path: str) -> Path:
    """把相對路徑解析成實際檔案，並確認它真的在專案資料夾底下。

    用 resolve() 之後比對而不是檢查字串裡有沒有 ".."：symlink 與 Windows 的
    8.3 短檔名都能繞過字串檢查，比對解析後的實體路徑才是可靠的。
    """
    root = project_dir().resolve()
    candidate = (root / rel_path).resolve()

    if candidate != root and root not in candidate.parents:
        raise NotInProject(f"路徑不在專案資料夾內：{rel_path}")
    if not candidate.is_file():
        raise ProjectError(f"檔案不存在：{rel_path}")
    return candidate


def kind_of(path: Path) -> str | None:
    suffix = path.suffix.lower()
    if suffix in VIDEO_SUFFIXES:
        return "video"
    if suffix in IMAGE_SUFFIXES:
        return "image"
    return None


def mime_of(path: Path) -> str:
    return MIME_TYPES.get(path.suffix.lower(), "application/octet-stream")


def list_media() -> list[MediaEntry]:
    """列出專案資料夾（含子目錄）裡的素材，依名稱排序。

    Phase 3 會改為查全域 SQLite 索引；Phase 1 直接掃資料夾就夠，
    素材量是幾十個等級。
    """
    root = project_dir().resolve()
    entries: list[MediaEntry] = []

    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        kind = kind_of(path)
        if kind is None:
            continue
        stat = path.stat()
        entries.append(
            MediaEntry(
                rel_path=path.relative_to(root).as_posix(),
                name=path.name,
                size=stat.st_size,
                modified=stat.st_mtime,
                kind=kind,
            )
        )

    return entries
