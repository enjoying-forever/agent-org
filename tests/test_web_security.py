"""The web page's defences: one-time sign-in, session cookie, headers, and what a POST must look like."""

import http.client
import json
import threading
import time

import pytest
import yaml

from agent_org import launch, ui

from .conftest import TEAM, FakeOpener


@pytest.fixture
def web(tmp_path, monkeypatch):
    (tmp_path / "project").mkdir()
    team_file = tmp_path / "team.yaml"
    team_file.write_text(yaml.safe_dump(TEAM, sort_keys=False), encoding="utf-8")
    monkeypatch.setattr(launch, "open_tab", lambda tab: None)
    srv, app, access = ui.serve(team_file, 0, load_models=False, watch=False)
    app.hub.opener = FakeOpener()
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]

    class Web:
        origin = f"http://127.0.0.1:{port}"

        def __init__(self):
            self.access, self.app = access, app

        def request(self, method, path, body=None, headers=None, raw=None):
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
            data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
            conn.request(method, path, body=data, headers={"Host": f"127.0.0.1:{port}", **(headers or {})})
            res = conn.getresponse()
            payload = res.read()
            conn.close()
            return res.status, dict(res.getheaders()), payload

        def sign_in(self):
            status, headers, _ = self.request("GET", f"/?code={access.new_code()}")
            assert status == 303
            return headers["Set-Cookie"].split(";")[0]

    yield Web()
    srv.shutdown()
    app.close()


def page_headers(cookie, **more):
    return {"Cookie": cookie, "X-Agent-Org": "1", **more}


def test_nothing_without_signing_in(web):
    status, _, body = web.request("GET", "/api/state", headers={"X-Agent-Org": "1"})
    assert status == 403 and b"not signed in" in body
    status, _, _ = web.request("GET", "/")  # the page itself loads, to show how to sign in
    assert status == 200


def test_a_sign_in_link_works_once(web):
    code = web.access.new_code()
    status, headers, _ = web.request("GET", f"/?code={code}")
    cookie = headers["Set-Cookie"]
    assert status == 303 and headers["Location"] == "/"
    assert "HttpOnly" in cookie and "SameSite=Strict" in cookie  # no script can read it; no other site sends it
    status, headers, _ = web.request("GET", f"/?code={code}")  # the same link again: nothing
    assert status == 303 and "Set-Cookie" not in headers


def test_a_sign_in_link_expires(web, monkeypatch):
    code = web.access.new_code()
    real = time.time
    monkeypatch.setattr(ui.time, "time", lambda: real() + ui.CODE_TTL + 1)
    _, headers, _ = web.request("GET", f"/?code={code}")
    assert "Set-Cookie" not in headers


def test_the_session_needs_the_pages_own_header(web):
    cookie = web.sign_in()
    assert web.request("GET", "/api/state", headers={"Cookie": cookie})[0] == 403  # e.g. a link from elsewhere
    assert web.request("GET", "/api/state", headers=page_headers(cookie))[0] == 200
    assert web.request("GET", "/api/state", headers=page_headers(f"{ui.COOKIE}=guess"))[0] == 403


def test_every_answer_carries_the_security_headers(web):
    for path in ("/", "/static/app.js", "/api/state"):
        _, headers, _ = web.request("GET", path)
        assert "frame-ancestors 'none'" in headers["Content-Security-Policy"]
        assert "script-src 'self'" in headers["Content-Security-Policy"]
        assert headers["X-Frame-Options"] == "DENY" and headers["X-Content-Type-Options"] == "nosniff"
        assert headers["Referrer-Policy"] == "no-referrer" and headers["Cache-Control"] == "no-store"


def test_what_a_post_must_look_like(web):
    cookie = web.sign_in()
    ok = page_headers(cookie, **{"Content-Type": "application/json"})
    body = {"to": "leader", "text": "hello"}
    assert web.request("POST", "/api/send", body, ok)[0] == 200
    # a form on another site can only send text/plain or form data
    form = page_headers(cookie, **{"Content-Type": "text/plain"})
    assert web.request("POST", "/api/send", body, form)[0] == 415
    # sent from another site (the browser says so)
    assert web.request("POST", "/api/send", body, {**ok, "Origin": "https://evil.example"})[0] == 403
    assert web.request("POST", "/api/send", body, {**ok, "Sec-Fetch-Site": "cross-site"})[0] == 403
    assert web.request("POST", "/api/send", body, {**ok, "Origin": web.origin, "Sec-Fetch-Site": "same-origin"})[0] == 200
    # bodies: too large, of unknown size, not an object, not JSON
    # a body declared too large is refused before anything is read (so only the size is sent here)
    too_big = {**ok, "Content-Length": str(ui.MAX_BODY + 10)}
    assert web.request("POST", "/api/send", headers=too_big, raw=b"{}")[0] == 413
    assert web.request("POST", "/api/send", headers={**ok, "Transfer-Encoding": "chunked"}, raw=b"")[0] == 411
    assert web.request("POST", "/api/send", headers=ok, raw=b"[1, 2]")[0] == 400
    assert web.request("POST", "/api/send", headers=ok, raw=b"{not json")[0] == 400
    assert web.request("POST", "/api/send", headers=ok, raw=b"[" * 100000 + b"]" * 100000)[0] in (400, 413)


def test_other_methods_and_cors_preflight_are_refused(web):
    for method in ("PUT", "DELETE", "PATCH", "OPTIONS"):
        status, headers, _ = web.request(method, "/api/send")
        assert status == 405 and "Access-Control-Allow-Origin" not in headers


def test_other_host_names_are_refused(web):
    status, _, _ = web.request("GET", "/", headers={"Host": "evil.example:80"})
    assert status == 403  # DNS rebinding


def test_a_crash_shows_no_details(web, monkeypatch):
    cookie = web.sign_in()
    monkeypatch.setitem(ui.GET_ROUTES, "/api/state", lambda app, q: 1 / 0)
    status, _, body = web.request("GET", "/api/state", headers=page_headers(cookie))
    assert status == 500 and b"ZeroDivision" not in body and b"Traceback" not in body
