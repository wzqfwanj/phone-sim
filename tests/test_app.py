#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""黑盒测试：起一个真实 HTTP 服务，走完整请求链路。

运行：python -m unittest discover -s tests -v
"""

import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

# 必须在 import app 之前指定临时数据目录（app 在导入时计算 DB_PATH）
_TMP_DIR = tempfile.mkdtemp(prefix="phone-sim-test-")
os.environ["DATA_DIR"] = _TMP_DIR

import app  # noqa: E402  (import 顺序是刻意的)


def request(method, url, payload=None):
    """返回 (状态码, 响应头, 原始字节)。"""
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read()


class PhoneSimTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app.init_db()
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        cls.server.daemon_threads = True
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        host, port = cls.server.server_address
        cls.base = "http://%s:%d" % (host, port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    # ---- 页面与静态资源 ----

    def test_index_page(self):
        status, headers, body = request("GET", self.base + "/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers["Content-Type"])
        html = body.decode("utf-8")
        self.assertIn("<title>安卓手机模拟器</title>", html)
        self.assertIn('href="style.css"', html)
        self.assertIn('src="app.js"', html)

    def test_static_assets(self):
        for path, ctype in (
            ("/style.css", "text/css"),
            ("/app.js", "text/javascript"),
            ("/favicon.svg", "image/svg+xml"),
        ):
            status, headers, body = request("GET", self.base + path)
            self.assertEqual(status, 200, path)
            self.assertIn(ctype, headers["Content-Type"], path)
            self.assertTrue(body, path)

    def test_favicon_ico_is_empty(self):
        status, _, body = request("GET", self.base + "/favicon.ico")
        self.assertEqual(status, 204)
        self.assertEqual(body, b"")

    def test_head_request_has_no_body(self):
        status, headers, body = request("HEAD", self.base + "/")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"")
        self.assertGreater(int(headers["Content-Length"]), 0)

    # ---- API ----

    def test_health(self):
        status, _, body = request("GET", self.base + "/api/health")
        self.assertEqual(status, 200)
        payload = json.loads(body)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["service"], "phone-sim")

    def test_device(self):
        status, _, body = request("GET", self.base + "/api/device")
        self.assertEqual(status, 200)
        payload = json.loads(body)
        self.assertEqual(payload["model"], "wkeeli Phone 1")
        self.assertIn("Android", payload["os"])
        self.assertIsInstance(payload["battery"], int)
        self.assertIn("server_time", payload)

    def test_notes_crud(self):
        # 初始列表（可能夹杂其它用例的数据，只断言能取到数组）
        status, _, body = request("GET", self.base + "/api/notes")
        self.assertEqual(status, 200)
        self.assertIsInstance(json.loads(body)["notes"], list)

        # 新增
        status, _, body = request("POST", self.base + "/api/notes", {"text": "  买牛奶  "})
        self.assertEqual(status, 201)
        note = json.loads(body)["note"]
        self.assertEqual(note["text"], "买牛奶")  # 前后空白被裁剪
        self.assertIn("created_at", note)

        # 读取
        status, _, body = request("GET", self.base + "/api/notes")
        notes = json.loads(body)["notes"]
        self.assertIn(note["id"], [item["id"] for item in notes])

        # 删除
        status, _, body = request("DELETE", self.base + "/api/notes/%d" % note["id"])
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["ok"])

        # 再删一次 → 404
        status, _, body = request("DELETE", self.base + "/api/notes/%d" % note["id"])
        self.assertEqual(status, 404)

    def test_notes_validation(self):
        cases = [
            ({"text": ""}, 400),
            ({"text": "   "}, 400),
            ({"text": "x" * 201}, 400),
            ({"text": 123}, 400),
            ({}, 400),
        ]
        for payload, expected in cases:
            status, _, _ = request("POST", self.base + "/api/notes", payload)
            self.assertEqual(status, expected, payload)

        status, _, _ = request("POST", self.base + "/api/notes", None)
        self.assertEqual(status, 400)  # 空请求体

        status, _, _ = request("DELETE", self.base + "/api/notes/abc")
        self.assertEqual(status, 400)

    def test_unknown_routes(self):
        for path in ("/nope", "/api/nope", "/../app.py", "/static/../app.py"):
            status, _, _ = request("GET", self.base + path)
            self.assertEqual(status, 404, path)

    def test_unsupported_method(self):
        status, _, _ = request("PUT", self.base + "/api/notes", {"text": "hi"})
        self.assertEqual(status, 405)
        status, _, _ = request("PATCH", self.base + "/api/notes", {"text": "hi"})
        self.assertEqual(status, 405)


if __name__ == "__main__":
    unittest.main(verbosity=2)
