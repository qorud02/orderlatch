"""Launch OrderLatch without copying existing credentials into this repository."""
from __future__ import annotations

import argparse
import hmac
import json
import os
import secrets
import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs

ROOT = Path(__file__).resolve().parents[1]


def runtime_environment() -> dict[str, str]:
    env = dict(os.environ)
    if not env.get("OPENAI_API_KEY") and os.name == "nt":
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
                env["OPENAI_API_KEY"] = winreg.QueryValueEx(key, "OPENAI_API_KEY")[0]
        except FileNotFoundError:
            pass
    # Never inherit live payment credentials as a fallback for this prototype.
    env["PAYPAL_MODE"] = "sandbox"
    env["PAYPAL_CLIENT_ID"] = env.get("PAYPAL_SANDBOX_CLIENT_ID", "")
    env["PAYPAL_CLIENT_SECRET"] = env.get("PAYPAL_SANDBOX_CLIENT_SECRET", "")
    env.setdefault("OPENAI_MODEL", "gpt-5.4-mini-2026-03-17")
    env.setdefault("AI_BUDGET_USD", "1.00")
    env["HOST"] = "127.0.0.1"
    return env


def start_app(env: dict[str, str], background: bool = False):
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js 22 or newer is required.")
    options = {"cwd": str(ROOT), "env": env}
    if background:
        # No credentials, request bodies or subprocess output are written to disk.
        options["stdout"] = subprocess.DEVNULL
        options["stderr"] = subprocess.DEVNULL
        if os.name == "nt":
            options["creationflags"] = subprocess.CREATE_NO_WINDOW
        return subprocess.Popen([node, "server.mjs"], **options)
    return subprocess.call([node, "server.mjs"], **options)


def setup_server(env: dict[str, str], setup_port: int):
    nonce = secrets.token_urlsafe(32)
    origin = f"http://127.0.0.1:{setup_port}"
    target = f"http://127.0.0.1:{env['PORT']}"
    page = """<!doctype html><html lang="en"><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>OrderLatch · Sandbox connection</title><style>
    *{box-sizing:border-box}body{font:16px system-ui;background:#f3f5f3;color:#132e34;margin:0;padding:40px 20px}
    main{max-width:620px;margin:auto;padding:36px;background:white;border:1px solid #dbe4df;border-radius:20px}
    h1{font-size:29px;letter-spacing:-1px}p{line-height:1.6;color:#476069}label{display:block;margin-top:22px;font-weight:650}
    input{width:100%;padding:14px;font:inherit;border:1px solid #b6c6c0;border-radius:8px;margin-top:8px}
    button{width:100%;background:#116754;color:white;border:0;border-radius:9px;padding:15px;font:600 16px system-ui;margin-top:28px}
    .tag{color:#116754;font-weight:700;font-size:12px;letter-spacing:2px}.small{font-size:13px}a{color:#116754}
    </style><main><div class="tag">LOCAL SETUP · SANDBOX ONLY</div>
    <h1>Connect the test payment account.</h1>
    <p>Use an existing <strong>Sandbox</strong> REST app from your PayPal developer account. This form sends the credentials only to this computer and keeps them in the running app's memory.</p>
    <p><a href="https://developer.paypal.com/dashboard/applications/sandbox" target="_blank" rel="noreferrer">Open PayPal Sandbox Apps &amp; Credentials ↗</a></p>
    <form method="post" action="/connect" autocomplete="off">
    <input type="hidden" name="nonce" value="NONCE">
    <label>Sandbox client ID<input type="password" name="client_id" required maxlength="250" autocomplete="off"></label>
    <label>Sandbox client secret<input type="password" name="client_secret" required maxlength="250" autocomplete="off"></label>
    <button type="submit">Connect Sandbox &amp; open OrderLatch</button></form>
    <p class="small">The existing OpenAI key is loaded from your local environment. No new key is created. This application always uses PayPal's Sandbox API.</p></main></html>""".replace("NONCE", nonce)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def send_safe_headers(self, status, content_type="text/html; charset=utf-8"):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "same-origin")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")

        def do_GET(self):
            if self.headers.get("Host") != f"127.0.0.1:{setup_port}" or self.path != "/":
                self.send_error(404)
                return
            self.send_safe_headers(200)
            self.end_headers()
            self.wfile.write(page.encode())

        def do_POST(self):
            if self.path != "/connect" or self.headers.get("Origin") != origin or self.headers.get("Host") != f"127.0.0.1:{setup_port}":
                self.send_error(403)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                self.send_error(400)
                return
            if not 1 <= length <= 4096:
                self.send_error(413)
                return
            try:
                values = parse_qs(self.rfile.read(length).decode("utf-8"), max_num_fields=4)
            except (UnicodeDecodeError, ValueError):
                self.send_error(400)
                return
            if not hmac.compare_digest(values.get("nonce", [""])[0], nonce):
                self.send_error(403)
                return
            client_id = values.get("client_id", [""])[0].strip()
            client_secret = values.get("client_secret", [""])[0].strip()
            if not all(10 <= len(s) <= 250 and not any(c.isspace() for c in s) for s in [client_id, client_secret]):
                self.send_safe_headers(400)
                self.end_headers()
                self.wfile.write(b"Please enter the Sandbox app credentials from the developer dashboard.")
                return
            env["PAYPAL_CLIENT_ID"] = client_id
            env["PAYPAL_CLIENT_SECRET"] = client_secret
            start_app(env, background=True)
            self.send_safe_headers(200)
            self.end_headers()
            self.wfile.write(("<title>Connected</title><h1>Sandbox configuration received.</h1>"
                               f"<p><a href='{target}'>Open OrderLatch</a></p>"
                               "<p>Keep this running demo local. Credentials have not been written to the project.</p>").encode())
            threading.Thread(target=self.server.shutdown, daemon=True).start()

    server = HTTPServer(("127.0.0.1", setup_port), Handler)
    print(json.dumps({"setup_url": origin, "app_url": target, "secrets_written": False}), flush=True)
    server.serve_forever()
    server.server_close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=4178)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--sandbox-setup", action="store_true")
    parser.add_argument("--setup-port", type=int, default=4180)
    args = parser.parse_args()
    env = runtime_environment()
    env["PORT"] = str(args.port)
    if args.check:
        print(json.dumps({"openai_key_available": bool(env.get("OPENAI_API_KEY")),
                          "sandbox_credentials_available": bool(env.get("PAYPAL_CLIENT_ID") and env.get("PAYPAL_CLIENT_SECRET")),
                          "paypal_mode": "sandbox", "secrets_written": False}))
        return
    if args.sandbox_setup:
        setup_server(env, args.setup_port)
    else:
        raise SystemExit(start_app(env))


if __name__ == "__main__":
    main()
