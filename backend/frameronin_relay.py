"""Single-account image relay. Run behind an HTTPS reverse proxy."""

import argparse
from collections import deque
from contextlib import contextmanager
from getpass import getpass
from hashlib import pbkdf2_hmac, sha256
from hmac import compare_digest
from http.client import HTTPException
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import sqlite3
import sys
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener


ORIGIN = 'https://adoin.github.io'
UPSTREAM = 'https://new.orbitix.site/v1'
ACCOUNT = 'adoin'
SESSION_SECONDS = 8 * 60 * 60
IMAGE_LIMIT = 24 * 1024 * 1024
ROUTES = ('/login', '/password', '/logout', '/generate')
LOGIN_ATTEMPTS = deque()
LOGIN_LOCK = threading.Lock()
GENERATION_SLOTS = threading.BoundedSemaphore(2)


class ApiError(Exception):
    def __init__(self, status, code):
        self.status = status
        self.code = code


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def digest(value):
    return sha256(value.encode()).hexdigest()


def password_hash(password, salt):
    return pbkdf2_hmac('sha256', password.encode(), salt, 600_000)


@contextmanager
def database(path):
    connection = sqlite3.connect(path, timeout=10)
    connection.row_factory = sqlite3.Row
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def initialize(path, initial_password, reset=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch(mode=0o600, exist_ok=True)
    setup_code = secrets.token_urlsafe(24)
    salt = secrets.token_bytes(16)
    with database(path) as db:
        db.execute('CREATE TABLE IF NOT EXISTS account (id INTEGER PRIMARY KEY, salt BLOB, password BLOB, setup TEXT)')
        db.execute('CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER)')
        if db.execute('SELECT 1 FROM account WHERE id = 1').fetchone() and not reset:
            raise SystemExit('Account already exists. Use reset to issue a new setup code.')
        db.execute('INSERT OR REPLACE INTO account VALUES (1, ?, ?, ?)',
                   (salt, password_hash(initial_password, salt), digest(setup_code)))
        db.execute('DELETE FROM sessions')
    print(setup_code)


def allow_login_attempt():
    with LOGIN_LOCK:
        now = time.monotonic()
        while LOGIN_ATTEMPTS and now - LOGIN_ATTEMPTS[0] >= 60:
            LOGIN_ATTEMPTS.popleft()
        if len(LOGIN_ATTEMPTS) >= 12:
            raise ApiError(429, 'too_many_attempts')
        LOGIN_ATTEMPTS.append(now)


def required_text(body, name, maximum):
    value = body.get(name)
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise ApiError(400, 'invalid_input')
    return value


class Relay(BaseHTTPRequestHandler):
    server_version = 'FrameRoninRelay'

    def send_data(self, status, data=b''):
        self.send_response(status)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Vary', 'Origin')
        if self.headers.get('Origin') == ORIGIN:
            self.send_header('Access-Control-Allow-Origin', ORIGIN)
            self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        if data:
            self.wfile.write(data)

    def send_json(self, status, data):
        self.send_data(status, json.dumps(data).encode())

    def do_OPTIONS(self):
        self.send_data(204 if self.path in ROUTES and self.headers.get('Origin') == ORIGIN else 403)

    def do_GET(self):
        if self.path == '/health':
            self.send_json(200, {'status': 'ok'})
        else:
            self.send_json(404, {'error': 'not_found'})

    def do_POST(self):
        try:
            if self.path not in ROUTES:
                raise ApiError(404, 'not_found')
            if self.headers.get('Origin') not in (None, ORIGIN):
                raise ApiError(403, 'origin_not_allowed')
            body = self.read_json()
            if self.path == '/login':
                self.login(body)
                return
            with database(self.server.database_path) as db:
                token = self.require_session(db)
                account = db.execute('SELECT * FROM account WHERE id = 1').fetchone()
                if self.path == '/logout':
                    db.execute('DELETE FROM sessions WHERE token = ?', (token,))
                    db.commit()
                    self.send_data(204)
                elif self.path == '/password':
                    self.change_password(db, account, body)
                elif account['setup'] is not None:
                    raise ApiError(403, 'password_change_required')
                else:
                    if not GENERATION_SLOTS.acquire(blocking=False):
                        raise ApiError(429, 'too_many_attempts')
                    try:
                        self.generate(body)
                    finally:
                        GENERATION_SLOTS.release()
        except ApiError as exc:
            self.send_json(exc.status, {'error': exc.code})

    def read_json(self):
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 32_768:
                raise ValueError
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError
            return body
        except (ValueError, UnicodeError):
            raise ApiError(400, 'invalid_input') from None

    def login(self, body):
        allow_login_attempt()
        username = required_text(body, 'username', 128)
        password = required_text(body, 'password', 256)
        with database(self.server.database_path) as db:
            account = db.execute('SELECT * FROM account WHERE id = 1').fetchone()
            if not account or not compare_digest(password_hash(password, account['salt']), account['password']) or username != ACCOUNT:
                raise ApiError(401, 'invalid_credentials')
            setup = account['setup']
            if setup is not None and not compare_digest(digest(str(body.get('setupCode', ''))), setup):
                raise ApiError(428, 'setup_code_required')
            token = secrets.token_urlsafe(32)
            now = int(time.time())
            db.execute('DELETE FROM sessions WHERE expires <= ?', (now,))
            created = db.execute('INSERT INTO sessions SELECT ?, ? FROM account WHERE id = 1 AND salt = ?',
                                 (digest(token), now + SESSION_SECONDS, account['salt']))
            if created.rowcount != 1:
                raise ApiError(409, 'account_changed')
        self.send_json(200, {'token': token, 'changeRequired': setup is not None})

    def require_session(self, db):
        kind, _, value = self.headers.get('Authorization', '').partition(' ')
        if kind.lower() != 'bearer' or not value or len(value) > 128:
            raise ApiError(401, 'login_required')
        token = digest(value)
        if not db.execute('SELECT 1 FROM sessions WHERE token = ? AND expires > ?', (token, int(time.time()))).fetchone():
            raise ApiError(401, 'login_required')
        return token

    def change_password(self, db, account, body):
        allow_login_attempt()
        old_password = required_text(body, 'password', 256)
        new_password = required_text(body, 'newPassword', 256)
        if len(new_password) < 12 or new_password == old_password:
            raise ApiError(400, 'invalid_new_password')
        if not compare_digest(password_hash(old_password, account['salt']), account['password']):
            raise ApiError(401, 'invalid_credentials')
        salt = secrets.token_bytes(16)
        changed = db.execute('UPDATE account SET salt = ?, password = ?, setup = NULL WHERE id = 1 AND password = ?',
                             (salt, password_hash(new_password, salt), account['password']))
        if changed.rowcount != 1:
            raise ApiError(409, 'account_changed')
        db.execute('DELETE FROM sessions')
        db.commit()
        self.send_data(204)

    def generate(self, body):
        api_key = required_text(body, 'apiKey', 512)
        if any(not 33 <= ord(char) <= 126 for char in api_key):
            raise ApiError(400, 'invalid_api_key')
        model = required_text(body, 'model', 128)
        prompt = required_text(body, 'prompt', 4000)
        mode = body.get('mode')
        if mode == 'images':
            route = '/images/generations'
            data = {'model': model, 'prompt': prompt, 'n': 1}
        elif mode == 'chat':
            route = '/chat/completions'
            data = {'model': model, 'messages': [{'role': 'user', 'content': prompt}], 'stream': False}
        else:
            raise ApiError(400, 'invalid_input')
        request = Request(UPSTREAM + route, data=json.dumps(data).encode(), headers={
            'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json',
        })
        try:
            with build_opener(NoRedirect()).open(request, timeout=150) as response:
                if response.headers.get_content_type() != 'application/json':
                    raise ApiError(502, 'invalid_upstream_response')
                result = response.read(IMAGE_LIMIT + 1)
        except HTTPError as exc:
            exc.close()
            self.send_json(502, {'error': 'upstream_error', 'upstreamStatus': exc.code})
            return
        except (URLError, OSError, HTTPException):
            raise ApiError(502, 'upstream_unavailable') from None
        if len(result) > IMAGE_LIMIT:
            raise ApiError(502, 'image_too_large')
        self.send_data(200, result)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=('init', 'reset', 'serve'))
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--port', type=int, default=8743)
    args = parser.parse_args()
    if args.command in ('init', 'reset'):
        password = getpass('Temporary password: ') if sys.stdin.isatty() else sys.stdin.readline().rstrip('\r\n')
        if not 1 <= len(password) <= 256:
            parser.error('Provide a temporary password of 1 to 256 characters.')
        initialize(args.database, password, reset=args.command == 'reset')
        return
    if not args.database.is_file():
        parser.error('Initialize the database before starting the relay.')
    with ThreadingHTTPServer(('127.0.0.1', args.port), Relay) as server:
        server.database_path = args.database
        server.serve_forever()


if __name__ == '__main__':
    main()
