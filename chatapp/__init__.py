"""chatapp — 用 Python 標準函式庫寫的多人聊天（通訊）系統。

包含三個部分：

* :mod:`chatapp.protocol` — NDJSON 傳輸協定
* :mod:`chatapp.server`   — 多執行緒 TCP 聊天伺服器
* :mod:`chatapp.client`   — 終端機客戶端
"""

__version__ = "1.0.0"
__all__ = ["protocol", "server", "client"]
