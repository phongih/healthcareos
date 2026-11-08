#!/usr/bin/env python3
"""Trả trạng thái vận hành cho uptime check: 200 chỉ khi file trạng thái bắt đầu bằng OK và còn mới; ngược lại 503. Không lộ chi tiết."""
import http.server, os, time

FILE = os.environ.get("STATUS_FILE", "/var/lib/hcos-status/status")
MAX_AGE = int(os.environ.get("MAX_AGE_S", "900"))
PORT = int(os.environ.get("PORT", "8090"))

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?")[0] != "/opsstatus":
            self.send_response(404); self.end_headers(); return
        try:
            st = os.stat(FILE)
            with open(FILE) as f:
                head = f.read(64)
            ok = head.startswith("OK") and (time.time() - st.st_mtime) <= MAX_AGE
        except OSError:
            ok = False
        body = b"OK\n" if ok else b"FAIL\n"
        self.send_response(200 if ok else 503)
        self.send_header("Content-Type", "text/plain"); self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a):
        pass

if __name__ == "__main__":
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
