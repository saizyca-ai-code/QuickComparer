"""ffprobe metadata。

D001 的第三項架構約束是「色彩 metadata 可外部覆寫」，這裡負責它的前半段：
**如實回報容器裡有什麼，缺的就是 null。** 後端不填假設值 —— 前端的
`ColorSpaceInfo` 已經有 origin 欄位負責區分「容器標記」與「假設值」，
若後端先猜一輪，那個區分就永遠是假的。

實測 test_assets 的 DLSS 產出：色彩標記全部缺漏、整支只有 1 個 keyframe。
兩者都是這條處理管線的常態，不是邊角案例，所以都要量出來給使用者看。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

#: 找不到時的錯誤訊息要指出這件事，不要靜默降級成「沒有 metadata」。
FFPROBE_ENV = "QC_FFPROBE"

PROBE_TIMEOUT_S = 30


class ProbeError(RuntimeError):
    pass


def ffprobe_path() -> str:
    """ffprobe 的位置：環境變數優先，其次系統 PATH。

    Phase 7 若決定隨附 binary，只要改這個函式。
    """
    override = os.environ.get(FFPROBE_ENV)
    if override:
        if not Path(override).is_file():
            raise ProbeError(f"{FFPROBE_ENV} 指向的檔案不存在：{override}")
        return override

    found = shutil.which("ffprobe")
    if not found:
        raise ProbeError(f"找不到 ffprobe。請把它放進 PATH，或以 {FFPROBE_ENV} 指定完整路徑。")
    return found


@dataclass
class ColorSpace:
    """容器裡的色彩標記。每一欄都可能是 None —— 那代表容器沒寫，不是預設值。"""

    primaries: str | None = None
    transfer: str | None = None
    matrix: str | None = None
    full_range: bool | None = None


@dataclass
class MediaInfo:
    path: str
    size: int
    duration: float | None
    width: int | None
    height: int | None
    frame_rate: float | None
    codec: str | None
    #: 影格總數。ffprobe 給不出來時為 None，不用時長乘 fps 硬湊。
    frame_count: int | None
    #: keyframe 數量。1 代表整支只有一個 keyframe，seek 成本會隨距離線性成長。
    keyframe_count: int | None
    has_b_frames: int | None
    color_space: ColorSpace = field(default_factory=ColorSpace)
    warnings: list[str] = field(default_factory=list)


def _run(args: list[str]) -> dict:
    try:
        result = subprocess.run(
            args,
            capture_output=True,
            timeout=PROBE_TIMEOUT_S,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired as exc:
        raise ProbeError(f"ffprobe 逾時（{PROBE_TIMEOUT_S}s）") from exc

    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", "replace").strip().splitlines()
        detail = stderr[-1] if stderr else f"exit code {result.returncode}"
        raise ProbeError(f"ffprobe 失敗：{detail}")

    return json.loads(result.stdout.decode("utf-8", "replace") or "{}")


def _parse_rational(value: str | None) -> float | None:
    """把 ffprobe 的 '30000/1001' 換成 float。'0/0' 代表沒有值。"""
    if not value:
        return None
    if "/" in value:
        num, _, den = value.partition("/")
        try:
            numerator, denominator = float(num), float(den)
        except ValueError:
            return None
        if denominator == 0:
            return None
        return numerator / denominator
    try:
        return float(value)
    except ValueError:
        return None


def _normalize(value: str | None) -> str | None:
    """ffprobe 用 'unknown' 表示沒有標記，要還原成 None。"""
    if value is None:
        return None
    lowered = value.strip().lower()
    if lowered in {"", "unknown", "unspecified", "n/a", "reserved"}:
        return None
    return lowered


def _count_keyframes(path: Path) -> int | None:
    """數 keyframe。

    只讀 packet 的 flags，不解碼，所以成本遠低於實際 seek。這個數字是 D002
    列為常規改善的「GOP 正規化」的判斷依據 —— 沒有它就不知道哪些素材該轉檔。
    """
    try:
        data = _run(
            [
                ffprobe_path(), "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "packet=flags",
                "-of", "json",
                str(path),
            ]
        )
    except ProbeError:
        return None

    packets = data.get("packets")
    if not isinstance(packets, list):
        return None
    return sum(1 for p in packets if isinstance(p.get("flags"), str) and "K" in p["flags"])


def probe(path: Path) -> MediaInfo:
    data = _run(
        [
            ffprobe_path(), "-v", "error",
            "-show_streams", "-show_format",
            "-select_streams", "v:0",
            "-of", "json",
            str(path),
        ]
    )

    streams = data.get("streams") or []
    if not streams:
        raise ProbeError(f"{path.name} 沒有視訊軌")
    stream = streams[0]
    fmt = data.get("format") or {}

    duration = _parse_rational(stream.get("duration")) or _parse_rational(fmt.get("duration"))
    frame_rate = _parse_rational(stream.get("avg_frame_rate")) or _parse_rational(
        stream.get("r_frame_rate")
    )

    frame_count = None
    raw_frames = stream.get("nb_frames")
    if isinstance(raw_frames, str) and raw_frames.isdigit():
        frame_count = int(raw_frames)

    color = ColorSpace(
        primaries=_normalize(stream.get("color_primaries")),
        transfer=_normalize(stream.get("color_transfer")),
        matrix=_normalize(stream.get("color_space")),
        full_range={"pc": True, "full": True, "tv": False, "limited": False}.get(
            (stream.get("color_range") or "").lower()
        ),
    )

    keyframe_count = _count_keyframes(path)

    info = MediaInfo(
        path=str(path),
        size=path.stat().st_size,
        duration=duration,
        width=stream.get("width"),
        height=stream.get("height"),
        frame_rate=frame_rate,
        codec=stream.get("codec_name"),
        frame_count=frame_count,
        keyframe_count=keyframe_count,
        has_b_frames=stream.get("has_b_frames"),
        color_space=color,
    )

    if color.primaries is None and color.transfer is None and color.matrix is None:
        info.warnings.append("容器沒有色彩標記，前端會套用 BT.709 假設值")
    if color.transfer in {"smpte2084", "arib-std-b67"}:
        info.warnings.append(f"HDR 素材（{color.transfer}），目前範圍外")
    if keyframe_count == 1:
        info.warnings.append("整支只有 1 個 keyframe，seek 成本會隨距離線性成長")

    return info
