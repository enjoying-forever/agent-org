import json

import pytest

from agent_org import sessions, usage

SID = "3f2c1a8e-1111-4a2b-9c3d-123456789abc"


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(sessions, "home", lambda: tmp_path)
    usage._cache.clear()
    usage._paths.clear()
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
    u = usage.usage("grok", SID)  # no finished turn yet: its messages
    assert (u.messages, u.model, u.tokens_out) == (42, "grok-4.7", 0)


def test_grok_usage_adds_up_its_finished_turns(home):
    folder = home / ".grok" / "sessions" / "E%3A%5Cproj" / SID
    folder.mkdir(parents=True)
    (folder / "summary.json").write_text(json.dumps({"num_chat_messages": 42, "current_model_id": "grok-4.7"}),
                                         encoding="utf-8")

    def turn(tokens_in, cached, out, calls):  # as Grok writes it when a turn ends
        return {"method": "_x.ai/session/update", "params": {"sessionId": SID, "update": {
            "sessionUpdate": "turn_completed", "stop_reason": "end_turn", "usage": {
                "inputTokens": tokens_in, "outputTokens": out, "totalTokens": tokens_in + out,
                "cachedReadTokens": cached, "reasoningTokens": out // 2, "modelCalls": calls}}}}

    chunk = {"method": "session/update", "params": {"update": {"sessionUpdate": "agent_message_chunk"},
                                                    "_meta": {"totalTokens": 1661}}}
    (folder / "updates.jsonl").write_text(lines(chunk, turn(2664859, 2181248, 50712, 22)), encoding="utf-8")
    u = usage.usage("grok", SID)
    # seen: the researcher's pane said "80 msg" though Grok had recorded 2,715,571 tokens
    assert (u.tokens_in, u.tokens_cached, u.tokens_out, u.messages) == (483611, 2181248, 50712, 22)
    with (folder / "updates.jsonl").open("a", encoding="utf-8") as f:  # the next turn ends: counted at once
        f.write(lines(turn(79189, 75648, 858, 3)))
    u = usage.usage("grok", SID)
    assert (u.tokens_in, u.tokens_cached, u.tokens_out, u.messages) == (483611 + 3541, 2181248 + 75648, 51570, 25)

def test_unknown_or_missing_conversations(home):
    assert usage.usage("claude", SID) is None
    assert usage.usage("claude", None) is None
    assert usage.usage("antigravity", SID) is None


def _varint(n):
    out = b""
    while True:
        b, n = n & 0x7F, n >> 7
        out += bytes([b | (0x80 if n else 0)])
        if not n:
            return out


def _pb(*fields):
    """A protobuf message from (number, int or bytes) fields."""
    out = b""
    for number, value in fields:
        if isinstance(value, int):
            out += _varint(number << 3) + _varint(value)
        else:
            out += _varint(number << 3 | 2) + _varint(len(value)) + value
    return out


def test_antigravity_usage_comes_from_its_conversation_database(home):
    import sqlite3
    folder = home / ".gemini" / "antigravity-cli" / "conversations"
    folder.mkdir(parents=True)
    db = sqlite3.connect(folder / f"{SID}.db")
    db.execute("CREATE TABLE gen_metadata (idx integer, data blob, size integer, PRIMARY KEY (idx))")
    # as Antigravity writes one model call: field 1 holds 4 (1 a constant, 2 input, 3 output, 5 cache reads)
    # and 19 (the model); measured against the usage `agy -p --output-format stream-json` reports
    calls = [(11755, 1, 0), (12588, 193, 300)]
    for i, (tokens_in, tokens_out, cached) in enumerate(calls):
        counts = _pb((1, 1319), (2, tokens_in), (3, tokens_out), *([(5, cached)] if cached else []), (6, 24))
        db.execute("INSERT INTO gen_metadata VALUES (?, ?, 0)",
                   (i, _pb((4, b"conv"), (1, _pb((3, 1319), (4, counts), (19, b"gemini-3.8-flash"))))))
    db.commit()
    db.close()
    u = usage.usage("antigravity", SID)
    assert (u.tokens_in, u.tokens_out, u.tokens_cached, u.messages, u.model) == (24343, 194, 300, 2, "gemini-3.8-flash")


def test_antigravity_usage_counts_calls_still_in_the_write_ahead_log(home):
    import sqlite3
    folder = home / ".gemini" / "antigravity-cli" / "conversations"
    folder.mkdir(parents=True)
    db = sqlite3.connect(folder / f"{SID}.db")  # kept open, as by the running agent: nothing is checkpointed
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("CREATE TABLE gen_metadata (idx integer, data blob, size integer, PRIMARY KEY (idx))")
    db.commit()

    def call(i, tokens_in):
        record = _pb((1, _pb((4, _pb((2, tokens_in), (3, 1))), (19, b"gemini-3.8-flash"))))
        db.execute("INSERT INTO gen_metadata VALUES (?, ?, 0)", (i, record))
        db.commit()

    try:
        assert usage.usage("antigravity", SID).messages == 0  # just started
        call(0, 1000)
        assert usage.usage("antigravity", SID).tokens_in == 1000  # (seen: stayed at 0 for a whole task)
        call(1, 500)
        assert usage.usage("antigravity", SID).tokens_in == 1500
    finally:
        db.close()


def test_deepseek_runs_keep_their_usage_by_conversation(tmp_path, monkeypatch):
    import io
    import sys as _sys
    from agent_org import runview
    kept = tmp_path / usage.DSH_USAGE
    step = lambda n: {"type": "status", "phase": "step_end", "usage": {  # noqa: E731
        "inputTokens": 1000 * n, "outputTokens": 10, "cacheReadTokens": 400, "cacheWriteTokens": 5}}

    def run(events):
        monkeypatch.setattr(_sys, "stdin", io.TextIOWrapper(io.BytesIO(lines(*events).encode("utf-8"))))
        monkeypatch.setattr(_sys, "stdout", io.TextIOWrapper(io.BytesIO(), encoding="utf-8"))
        runview._counted.clear()  # each run is its own process
        assert runview.main(["--usage-file", str(kept)]) == 0

    run([{"type": "session", "sessionId": "session-a"}, step(1), step(2), {"type": "final", "text": "hi"}])
    run([{"type": "session", "sessionId": "session-a"}, step(3)])  # the next run continues it
    run([{"type": "session", "sessionId": "session-b"}, step(1)])  # Start fresh: a new conversation
    u = usage.deepseek(kept)
    assert (u.tokens_in, u.tokens_cached, u.tokens_out, u.messages) == (7020, 1600, 40, 4)
    assert set(json.loads(kept.read_text(encoding="utf-8"))) == {"session-a", "session-b"}


def test_an_agents_usage_adds_up_over_all_its_conversations(home):
    folder = home / ".claude" / "projects" / "E--proj"
    folder.mkdir(parents=True)
    other = "4f2c1a8e-2222-4a2b-9c3d-123456789abc"
    for sid, n in ((SID, 100), (other, 50)):
        reply = {"id": f"m-{sid}", "model": "claude-sonnet-5-5", "usage": {"input_tokens": n, "output_tokens": 1}}
        (folder / f"{sid}.jsonl").write_text(lines({"type": "assistant", "message": reply}), encoding="utf-8")
    both = usage.total([usage.usage("claude", SID), usage.usage("claude", other)])
    assert (both.tokens_in, both.tokens_out, both.messages) == (150, 2, 2)
