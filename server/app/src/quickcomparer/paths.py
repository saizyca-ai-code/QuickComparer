"""服務根目錄與執行期路徑。

`_Habits/Portable Python Service Development` 的第 4 條：`data/` 等執行期資料
永遠以服務根目錄為基準，不依賴目前工作目錄或安裝位置。Phase 7 換成可搬移形式時，
這個檔案是唯一需要確認的地方。
"""

from __future__ import annotations

import os
from pathlib import Path

# quickcomparer/paths.py → app/src/quickcomparer → app/src → app → SERVICE_ROOT
SERVICE_ROOT = Path(__file__).resolve().parents[3]

DATA_DIR = Path(os.environ.get("QC_DATA_DIR") or (SERVICE_ROOT / "data"))

DB_PATH = DATA_DIR / "quickcomparer.sqlite3"


def ensure_data_dir() -> Path:
    """建立執行期目錄。啟動時呼叫，不在 import 時產生副作用。"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    return DATA_DIR
