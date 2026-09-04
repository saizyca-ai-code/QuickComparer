"""QuickComparer 本機服務。

依 D001 的結論，server 是薄層：只提供檔案 bytes 與 metadata，不參與解碼與合成。
打包形式（portable 服務／Tauri／Docker）延後到 Phase 7，所以這裡不假設任何
安裝位置，所有路徑都從服務根目錄推導。
"""

__all__ = ["__version__"]

__version__ = "0.1.0"
