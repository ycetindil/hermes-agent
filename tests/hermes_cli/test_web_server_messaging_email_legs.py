"""Email legs: a half-working channel reads as "partial" (warn), never red "fatal".

``GET /api/messaging/platforms`` carries the adapter's per-leg probe results
(``legs``) in the runtime record. When exactly one leg works the payload
derives state ``partial`` and a plain-words sentence — "Sending — works /
Receiving — unavailable: the provider offers no public IMAP" for the Proton
case — instead of repeating the stored single ``fatal``. Both legs down, an
auth failure, or a stopped gateway keep the old verdicts.
"""
import json
import os
from pathlib import Path

import pytest


def _legs(*, receive_ok, receive_code=None, receive_message=None,
          send_ok=True, send_code=None, send_message=None):
    return {
        "receive": {"ok": receive_ok, "code": receive_code,
                    "message": receive_message, "retryable": True},
        "send": {"ok": send_ok, "code": send_code,
                 "message": send_message, "retryable": True},
    }


_LEGS_PROTON = _legs(
    receive_ok=False, receive_code="email_imap_connect_error",
    receive_message="IMAP connection to imap.protonmail.com:993 failed: [Errno 111] Connection refused",
    send_ok=True,
)
_LEGS_BOTH_DOWN = _legs(
    receive_ok=False, receive_code="email_imap_connect_error",
    receive_message="IMAP connection to imap.example.com:993 failed: [Errno 111] Connection refused",
    send_ok=False, send_code="email_smtp_connect_error",
    send_message="SMTP connection to smtp.example.com failed: [Errno 111] Connection refused",
)
_LEGS_UNKNOWN_HOST = _legs(
    receive_ok=False, receive_code="email_imap_connect_error",
    receive_message="IMAP connection to imap.example.com:993 failed: [Errno 111] Connection refused",
    send_ok=True,
)


def _email_env(home: Path) -> None:
    (home / ".env").write_text(
        "EMAIL_ADDRESS=bot@example.com\nEMAIL_PASSWORD=app-password\n"
        "EMAIL_IMAP_HOST=imap.protonmail.com\nEMAIL_SMTP_HOST=smtp.example.com\n",
        encoding="utf-8",
    )
    (home / "config.yaml").write_text(
        "platforms:\n  email:\n    enabled: true\n", encoding="utf-8")


def _live_gateway_state(home: Path, email_entry: dict) -> None:
    """A live gateway record: this pytest process's PID wearing a gateway
    command line (same liveness fake as the posture tests)."""
    import gateway.status as _gw_status

    start_time = _gw_status._get_process_start_time(os.getpid())
    (home / "gateway.pid").write_text(
        json.dumps({"pid": os.getpid(), "hermes_home": str(home)}), encoding="utf-8")
    (home / "gateway_state.json").write_text(json.dumps({
        "pid": os.getpid(), "hermes_home": str(home), "gateway_state": "running",
        "kind": "hermes-gateway", "start_time": start_time,
        "updated_at": "2026-01-01T00:00:00+00:00",
        "platforms": {"email": email_entry},
    }), encoding="utf-8")


@pytest.fixture
def live_client(monkeypatch, _isolate_hermes_home):
    from starlette.testclient import TestClient

    import gateway.status as _gw_status
    from hermes_constants import get_hermes_home
    from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN

    home = get_hermes_home()
    cmdline = {"current": "hermes gateway run"}
    monkeypatch.setattr(
        _gw_status, "_read_process_cmdline", lambda pid: cmdline["current"])
    _email_env(home)
    _live_gateway_state(home, {
        "state": "fatal", "error_code": "email_imap_connect_error",
        "error_message": "IMAP connection to imap.protonmail.com:993 failed: [Errno 111] Connection refused",
        "legs": _LEGS_PROTON, "writer_pid": os.getpid(),
    })
    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


@pytest.fixture
def stopped_client(monkeypatch, _isolate_hermes_home):
    from starlette.testclient import TestClient

    from hermes_constants import get_hermes_home
    from hermes_cli.web_server import app, _SESSION_HEADER_NAME, _SESSION_TOKEN

    home = get_hermes_home()
    _email_env(home)
    (home / "gateway_state.json").write_text(json.dumps({
        "kind": "gateway", "pid": 999_999_999, "start_time": 1.0,
        "gateway_state": "stopped", "exit_reason": "shutdown",
        "updated_at": "2026-01-01T00:00:00+00:00",
        "platforms": {"email": {
            "state": "fatal", "error_code": "email_imap_connect_error",
            "error_message": "IMAP connection to imap.protonmail.com:993 failed",
            "legs": _LEGS_PROTON,
            "writer_pid": 999_999_999, "writer_start_time": 1.0,
        }},
    }), encoding="utf-8")
    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


def _email_entry(client, *, legs=None, state="fatal", error_code="email_imap_connect_error",
                 error_message="IMAP connection to imap.protonmail.com:993 failed"):
    """Rewrite the live gateway record's email entry, then read the payload."""
    from hermes_constants import get_hermes_home

    home = get_hermes_home()
    entry = {"state": state, "error_code": error_code,
             "error_message": error_message, "writer_pid": os.getpid()}
    if legs is not None:
        entry["legs"] = legs
    _live_gateway_state(home, entry)
    payload = client.get("/api/messaging/platforms").json()
    return next(p for p in payload["platforms"] if p["id"] == "email")


def test_split_legs_render_partial_in_plain_words(live_client):
    email = _email_entry(live_client, legs=_LEGS_PROTON)

    assert email["gateway_running"] is True
    assert email["configured"] is True
    assert email["state"] == "partial"
    assert email["error_code"] == "email_imap_connect_error"
    assert email["error_message"] == (
        "Sending — works / Receiving — unavailable: the provider offers no public IMAP")
    assert email["legs"] == _LEGS_PROTON


def test_both_legs_down_stays_fatal(live_client):
    email = _email_entry(
        live_client, legs=_LEGS_BOTH_DOWN,
        error_message="IMAP connection to imap.example.com:993 failed: [Errno 111] Connection refused")

    assert email["state"] == "fatal"
    assert email["error_code"] == "email_imap_connect_error"
    # No split to narrate: the raw failing-leg message stands.
    assert email["error_message"] == (
        "IMAP connection to imap.example.com:993 failed: [Errno 111] Connection refused")
    assert email["legs"] == _LEGS_BOTH_DOWN


def test_split_legs_unknown_host_falls_back_to_raw_message(live_client):
    email = _email_entry(
        live_client, legs=_LEGS_UNKNOWN_HOST,
        error_message="IMAP connection to imap.example.com:993 failed: [Errno 111] Connection refused")

    assert email["state"] == "partial"
    assert email["error_message"] == (
        "Sending — works / Receiving — unavailable: "
        "IMAP connection to imap.example.com:993 failed: [Errno 111] Connection refused")


def test_split_legs_with_smtp_auth_failure_stays_fatal(live_client):
    legs = _legs(
        receive_ok=True,
        send_ok=False, send_code="email_auth_error",
        send_message="SMTP authentication failed for bot@example.com: (535, b'authentication failed')",
    )
    legs["send"]["retryable"] = False
    email = _email_entry(
        live_client, legs=legs,
        error_message="SMTP authentication failed for bot@example.com: (535, b'authentication failed')",
        error_code="email_auth_error")

    # Auth can never self-heal: never softened to partial.
    assert email["state"] == "fatal"
    assert email["error_code"] == "email_auth_error"
    assert email["legs"] == legs


def test_stopped_gateway_drops_stale_legs(stopped_client):
    payload = stopped_client.get("/api/messaging/platforms").json()
    email = next(p for p in payload["platforms"] if p["id"] == "email")

    assert email["gateway_running"] is False
    assert email["state"] == "gateway_stopped"
    assert email["error_code"] is None
    assert email["error_message"] is None
    assert email["legs"] is None
