"""Call configured local GitFerry MCP when a chat has not loaded its native tools."""
import argparse
import json
import os
from pathlib import Path
import sys
import tomllib
import urllib.error
import urllib.parse
import urllib.request


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise RuntimeError("GitFerry endpoint redirected; check its configured local URL")


def configuration(client):
    home = Path.home()
    codex = Path(os.environ.get("CODEX_HOME", home / ".codex")) / "config.toml"
    claude = home / ".claude.json"
    if client != "claude" and codex.exists():
        server = tomllib.loads(codex.read_text(encoding="utf-8")).get("mcp_servers", {}).get("gitferry")
        if server is not None:
            if server.get("enabled") is False:
                raise RuntimeError("GitFerry MCP is disabled in Codex configuration")
            headers = dict(server.get("http_headers", {}))
            for header, variable in server.get("env_http_headers", {}).items():
                headers[header] = os.environ[variable]
            variable = server.get("bearer_token_env_var")
            if variable:
                headers["Authorization"] = "Bearer " + os.environ[variable]
            return server["url"], headers
    if client != "codex" and claude.exists():
        server = json.loads(claude.read_text(encoding="utf-8")).get("mcpServers", {}).get("gitferry")
        if server is not None:
            return server["url"], dict(server.get("headers", {}))
    raise RuntimeError("No gitferry MCP entry found in the selected client configuration")


def messages(body, content_type):
    if not body:
        return []
    if "text/event-stream" not in content_type:
        return [json.loads(body)]
    results, data = [], []
    for line in body.splitlines() + [""]:
        if not line:
            value = "\n".join(data).strip()
            if value:
                results.append(json.loads(value))
            data = []
        elif line.startswith("data:"):
            data.append(line[5:].removeprefix(" "))
    return results


class Client:
    def __init__(self, url, headers):
        parsed = urllib.parse.urlsplit(url)
        if (parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost", "::1")
                or parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment):
            raise RuntimeError("Fallback requires a plain HTTP loopback GitFerry URL")
        # Validate the port before sending credentials. Never use system proxies or redirects.
        if not parsed.port:
            raise RuntimeError("GitFerry URL must specify its local MCP port")
        authorization = next((value for key, value in headers.items() if key.lower() == "authorization"), "")
        if not authorization.startswith("Bearer ") or not authorization[7:]:
            raise RuntimeError("Saved GitFerry bearer authentication is missing")
        self.url, self.session, self.version = url, None, None
        self.headers = {**headers, "Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        self.secret = authorization[7:]
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirects())

    def redacted(self, value):
        return value.replace(self.secret, "[REDACTED]")

    def rpc(self, method, params=None, request_id=None):
        payload = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            payload["params"] = params
        if request_id is not None:
            payload["id"] = request_id
        headers = dict(self.headers)
        if self.session:
            headers["Mcp-Session-Id"] = self.session
        if self.version:
            headers["MCP-Protocol-Version"] = self.version
        request = urllib.request.Request(self.url, json.dumps(payload).encode(), headers=headers)
        with self.opener.open(request, timeout=55) as response:
            self.session = response.headers.get("Mcp-Session-Id", self.session)
            values = messages(response.read().decode(), response.headers.get("Content-Type", ""))
        if request_id is None:
            return None
        for value in values:
            if value.get("id") == request_id:
                if "error" in value:
                    raise RuntimeError(self.redacted(json.dumps(value["error"])))
                return value["result"]
        raise RuntimeError("GitFerry did not return a matching MCP response")

    def initialize(self):
        result = self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                         "clientInfo": {"name": "gitferry-skill", "version": "1"}}, 1)
        self.version = result["protocolVersion"]
        self.rpc("notifications/initialized")

    def close(self):
        if self.session:
            headers = {**self.headers, "Mcp-Session-Id": self.session}
            if self.version:
                headers["MCP-Protocol-Version"] = self.version
            try:
                with self.opener.open(urllib.request.Request(self.url, headers=headers, method="DELETE"), timeout=5):
                    pass
            except (OSError, RuntimeError):
                pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tool", help="GitFerry tool name, or tools/list to inspect schemas")
    parser.add_argument("--client", choices=("auto", "codex", "claude"), default="auto")
    arguments = parser.add_mutually_exclusive_group()
    arguments.add_argument("--arguments", default="{}", help="Tool argument JSON")
    arguments.add_argument("--arguments-file", type=Path, help="Read tool argument JSON from a file")
    options = parser.parse_args()
    client = None
    try:
        raw = options.arguments_file.read_text(encoding="utf-8") if options.arguments_file else options.arguments
        values = json.loads(raw)
        if not isinstance(values, dict):
            raise RuntimeError("Tool arguments must be a JSON object")
        client = Client(*configuration(options.client))
        client.initialize()
        tools = client.rpc("tools/list", {}, 2)
        if options.tool == "tools/list":
            result = tools
        else:
            if options.tool not in {tool["name"] for tool in tools["tools"]}:
                raise RuntimeError("Requested tool is not exposed by GitFerry")
            result = client.rpc("tools/call", {"name": options.tool, "arguments": values}, 3)
        print(client.redacted(json.dumps(result, ensure_ascii=True)))
        return 1 if result.get("isError") else 0
    except Exception as error:
        message = str(error)
        print("GitFerry MCP: " + (client.redacted(message) if client else message), file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == "__main__":
    sys.exit(main())
