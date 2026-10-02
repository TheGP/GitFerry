"""Transport and credential-boundary tests; no real credentials or Git operations."""
import importlib.util
import json
from pathlib import Path
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("gitferry_call", Path(__file__).parents[1] / "scripts/call.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class HelperTests(unittest.TestCase):
    def test_sse_priming_and_multiline_data(self):
        body = 'event: message\ndata:\n\ndata: {"id": 1,\ndata: "result": {"ok": true}}\n\n'
        self.assertEqual(helper.messages(body, "text/event-stream"), [{"id": 1, "result": {"ok": True}}])

    def test_credentials_require_explicit_loopback_endpoint(self):
        for url in ("https://example.com/mcp", "http://127.0.0.1.evil:80/mcp",
                    "http://user@127.0.0.1:80/mcp", "http://127.0.0.1/mcp",
                    "http://127.0.0.1:80/mcp?token=secret"):
            with self.subTest(url=url), self.assertRaises(RuntimeError):
                helper.Client(url, {"Authorization": "Bearer dummy-secret"})

    def test_session_protocol_and_no_proxy_with_tool_error_redaction(self):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append((payload, {key.lower(): value for key, value in self.headers.items()}))
                if "id" not in payload:
                    self.send_response(202)
                    self.end_headers()
                    return
                result = {"protocolVersion": "2025-06-18"} if payload["method"] == "initialize" else {}
                if payload["method"] == "tools/call":
                    response = {"id": payload["id"], "error": {"message": "dummy-secret"}}
                else:
                    response = {"id": payload["id"], "result": result}
                body = ('data:\n\ndata: ' + json.dumps(response) + '\n\n').encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Mcp-Session-Id", "test-session")
                self.end_headers()
                self.wfile.write(body)

            def do_DELETE(self):
                requests.append(({"method": "DELETE"}, {key.lower(): value for key, value in self.headers.items()}))
                self.send_response(204)
                self.end_headers()

        with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with patch.dict("os.environ", {"HTTP_PROXY": "http://127.0.0.1:1", "NO_PROXY": ""}):
                    client = helper.Client(f"http://127.0.0.1:{server.server_port}/mcp", {"Authorization": "Bearer dummy-secret"})
                    client.initialize()
                    with self.assertRaisesRegex(RuntimeError, r"\[REDACTED\]") as failure:
                        client.rpc("tools/call", {"name": "get_view", "arguments": {}}, 2)
                    self.assertNotIn("dummy-secret", str(failure.exception))
                    client.close()
                for payload, headers in requests:
                    self.assertEqual(headers["authorization"], "Bearer dummy-secret")
                    if payload["method"] != "initialize":
                        self.assertEqual(headers["mcp-session-id"], "test-session")
                        self.assertEqual(headers["mcp-protocol-version"], "2025-06-18")
                self.assertEqual(requests[-1][0]["method"], "DELETE")
            finally:
                server.shutdown()
                thread.join(timeout=2)

    def test_redirect_cannot_forward_authentication(self):
        with self.assertRaisesRegex(RuntimeError, "redirected"):
            helper.NoRedirects().redirect_request(None, None, 307, "Redirect", {}, "http://example.com")


if __name__ == "__main__":
    unittest.main()
