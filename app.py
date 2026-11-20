#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""安卓手机模拟器 · 后端（Python 标准库，零第三方依赖）

职责：
  1. 托管前端静态文件（index.html / style.css / app.js / favicon.svg）
  2. 提供模拟设备信息（/api/device）与备忘录持久化（/api/notes，SQLite）
  3. 不做应用内登录：线上由 Caddy 全站 Basic Auth 统一保护

环境变量：
  HOST      监听地址，默认 0.0.0.0
  PORT      监听端口，默认 8140
  DATA_DIR  数据目录，默认 ./data（生产为 /var/lib/phone-sim）
  APP_TZ    时区，默认 Asia/Shanghai（系统无 tzdata 时退化为 UTC+8）

启动：python app.py  →  http://127.0.0.1:8140
"""

import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8140"))
DATA_DIR = os.environ.get("DATA_DIR") or os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "notes.db")
START_TIME = time.time()

NOTE_MAX_LEN = 200
MAX_BODY = 64 * 1024

# 时区：优先 zoneinfo，缺少 tzdata 的机器（如 Windows 默认环境）退化为 UTC+8
try:
    from zoneinfo import ZoneInfo

    TZ = ZoneInfo(os.environ.get("APP_TZ", "Asia/Shanghai"))
except Exception:  # noqa: BLE001 - 时区不可用时不影响主流程
    TZ = timezone(timedelta(hours=8))

STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/favicon.svg": ("favicon.svg", "image/svg+xml"),
}

# 模拟设备信息：仅界面演示用，非真实硬件
DEVICE = {
    "brand": "wkeeli",
    "model": "wkeeli Phone 1",
    "os": "Android 14（模拟）",
    "resolution": "360 × 780",
    "battery": 86,
    "storage": "128 GB",
    "network": "Wi-Fi",
    "sim": "双卡待机（模拟）",
}


# ---------------------------------------------------------------- SQLite


def db_connect():
    """每次请求新建连接；SQLite 文件级锁 + 5s 超时足够本应用并发。"""
    conn = sqlite3.connect(DB_PATH, timeout=5)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    with db_connect() as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS notes ("
            " id INTEGER PRIMARY KEY AUTOINCREMENT,"
            " text TEXT NOT NULL,"
            " created_at TEXT NOT NULL)"
        )


def note_row(row):
    return {"id": row["id"], "text": row["text"], "created_at": row["created_at"]}


def list_notes():
    with db_connect() as conn:
        rows = conn.execute(
            "SELECT id, text, created_at FROM notes ORDER BY id DESC"
        ).fetchall()
    return [note_row(row) for row in rows]


def create_note(text):
    created_at = datetime.now(TZ).isoformat(timespec="seconds")
    with db_connect() as conn:
        cur = conn.execute(
            "INSERT INTO notes (text, created_at) VALUES (?, ?)", (text, created_at)
        )
        note_id = cur.lastrowid
    return {"id": note_id, "text": text, "created_at": created_at}


def delete_note(note_id):
    with db_connect() as conn:
        cur = conn.execute("DELETE FROM notes WHERE id = ?", (note_id,))
    return cur.rowcount > 0


# ---------------------------------------------------------------- HTTP


class Handler(BaseHTTPRequestHandler):
    server_version = "phone-sim/1.0"
    protocol_version = "HTTP/1.1"

    # ---- 通用响应 ----

    def _send(self, status, body=b"", content_type="text/plain; charset=utf-8", head_only=False):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        if content_type.startswith("application/json"):
            self.send_header("Cache-Control", "no-store")
        else:
            self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if body and not head_only:
            self.wfile.write(body)

    def _json(self, status, payload, head_only=False):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8", head_only)

    def _error(self, status, message, head_only=False):
        self._json(status, {"error": message}, head_only)

    def _read_json(self):
        """读取并解析请求体；返回 (payload, 错误信息)。"""
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None, "Content-Length 不合法"
        if length <= 0:
            return None, "请求体为空"
        if length > MAX_BODY:
            return None, "请求体过大"
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None, "请求体不是合法 JSON"
        if not isinstance(payload, dict):
            return None, "请求体必须是 JSON 对象"
        return payload, None

    # ---- 路由分发 ----

    def do_GET(self):
        self._route(head_only=False)

    def do_HEAD(self):
        self._route(head_only=True)

    def do_POST(self):
        path = urlparse(self.path).path.rstrip("/") or "/"
        if path != "/api/notes":
            return self._error(404, "接口不存在")
        payload, err = self._read_json()
        if err:
            return self._error(400, err)
        text = payload.get("text")
        if not isinstance(text, str):
            return self._error(400, "text 必须是字符串")
        text = text.strip()
        if not text:
            return self._error(400, "备忘录内容不能为空")
        if len(text) > NOTE_MAX_LEN:
            return self._error(400, "备忘录内容不能超过 %d 字" % NOTE_MAX_LEN)
        note = create_note(text)
        self._json(201, {"note": note})

    def do_DELETE(self):
        path = urlparse(self.path).path.rstrip("/")
        prefix = "/api/notes/"
        if not path.startswith(prefix):
            return self._error(404, "接口不存在")
        raw_id = path[len(prefix):]
        if not raw_id.isdigit():
            return self._error(400, "备忘录 id 不合法")
        if not delete_note(int(raw_id)):
            return self._error(404, "备忘录不存在")
        self._json(200, {"ok": True})

    def do_PUT(self):
        self._error(405, "不支持的请求方法")

    def do_PATCH(self):
        self._error(405, "不支持的请求方法")

    def _route(self, head_only=False):
        path = unquote(urlparse(self.path).path)
        if path == "/favicon.ico":
            return self._send(204, b"", "image/x-icon", head_only)
        if path.startswith("/api/"):
            return self._api(path, head_only)
        static = STATIC_FILES.get(path)
        if static is None:
            return self._error(404, "页面不存在", head_only)
        filename, content_type = static
        full_path = os.path.join(BASE_DIR, filename)
        try:
            with open(full_path, "rb") as fh:
                body = fh.read()
        except OSError:
            return self._error(500, "静态文件缺失：%s" % filename, head_only)
        self._send(200, body, content_type, head_only)

    def _api(self, path, head_only=False):
        path = path.rstrip("/") or "/"
        if path == "/api/health":
            return self._json(
                200,
                {
                    "ok": True,
                    "service": "phone-sim",
                    "time": datetime.now(TZ).isoformat(timespec="seconds"),
                    "uptime": int(time.time() - START_TIME),
                },
                head_only,
            )
        if path == "/api/device":
            payload = dict(DEVICE)
            payload["uptime"] = int(time.time() - START_TIME)
            payload["server_time"] = datetime.now(TZ).isoformat(timespec="seconds")
            return self._json(200, payload, head_only)
        if path == "/api/notes":
            notes = list_notes()
            return self._json(200, {"notes": notes, "count": len(notes)}, head_only)
        return self._error(404, "接口不存在", head_only)

    # ---- 日志（保持单行，便于 journalctl 阅读）----

    def log_message(self, fmt, *args):
        sys.stderr.write(
            "[phone-sim] %s %s\n" % (datetime.now(TZ).strftime("%H:%M:%S"), fmt % args)
        )


def main():
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    print(
        "[phone-sim] serving on http://%s:%d  (data: %s)" % (HOST, PORT, DATA_DIR),
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[phone-sim] bye", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
