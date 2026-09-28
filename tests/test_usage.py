import json

import pytest

from agent_org import sessions, usage

SID = "3f2c1a8e-1111-4a2b-9c3d-123456789abc"


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(sessions, "home", lambda: tmp_path)
    usage._cache.clear()
    return tmp_path


def lines(*records):
    return "\n".join(json.dumps(r) for r in records) + "\n"


def test_claude_usage_counts_each_reply_once(home):
    folder = home / ".claude" / "projects" / "E--proj"
    folder.mkdir(parents=True)
    reply = {"id": "msg_1", "model": "claude-opus-5-5",
             "usage": {"input_tokens": 10, "cache_creation_input_tokens": 90, "cache_read_input_tokens": 1000,
                       "output_tokens": 50}}
    other = {"id": "msg_2", "model": "claude-opus-5-5",
             "usage": {"input_tokens": 5, "cache_read_input_tokens": 1100, "output_tokens": 20}}
    (folder / f"{SID}.jsonl").write_text(lines(
        {"type": "user", "message": {"role": "user", "content": "hi"}},
        {"type": "assistant", "message": reply}, {"type": "assistant", "message": reply},  # same reply twice
        {"type": "assistant", "message": other}), encoding="utf-8")
    u = usage.usage("claude", SID)
    assert (u.tokens_in, u.tokens_cached, u.tokens_out, u.messages, u.model) == (105, 2100, 70, 2, "claude-opus-5-5")


def test_codex_usage_and_subscription_limits(home):
    day = home / ".codex" / "sessions" / "2026" / "09" / "28"
    day.mkdir(parents=True)
    count = {"type": "event_msg", "payload": {
        "type": "token_count",
        "info": {"total_token_usage": {"input_tokens": 1000, "cached_input_tokens": 600,
                                       "output_tokens": 40, "reasoning_output_tokens": 10}},
        "rate_limits": {"primary": {"used_percent": 23.4, "window_minutes": 300},
                        "secondary": {"used_percent": 61, "window_minutes": 10080}}}}
    (day / f"rollout-2026-09-28T17-17-06-{SID}.jsonl").write_text(lines(
        {"type": "session_meta", "payload": {"id": SID}},
        {"type": "turn_context", "payload": {"model": "gpt-6-luna"}}, count), encoding="utf-8")
    u = usage.usage("codex", SID)
    assert (u.tokens_in, u.tokens_cached, u.tokens_out, u.model) == (400, 600, 50, "gpt-6-luna")
    assert u.limits == ["5h limit: 23% used", "7d limit: 61% used"]


def test_grok_reports_messages_and_model(home):
    folder = home / ".grok" / "sessions" / "E%3A%5Cproj" / SID
    folder.mkdir(parents=True)
    (folder / "summary.json").write_text(json.dumps({"num_chat_messages": 42, "current_model_id": "grok-4.7"}),
                                         encoding="utf-8")
    u = usage.usage("grok", SID)
    assert (u.messages, u.model, u.tokens_out) == (42, "grok-4.7", 0)


def test_unknown_or_missing_conversations(home):
    assert usage.usage("claude", SID) is None
    assert usage.usage("claude", None) is None
    assert usage.usage("antigravity", SID) is None
