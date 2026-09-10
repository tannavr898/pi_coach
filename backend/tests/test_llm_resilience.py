"""Recovery behaviour for model replies that come back unusable.

These cover the failure that actually reached students: a 200 OK whose body
isn't parseable JSON. The Anthropic SDK retries transport faults on its own
(429s, 5xx, dropped connections), so those are already handled — but a
well-formed HTTP response carrying a dropped comma, a wrapper paragraph, or a
reply cut off at `max_tokens` looked like success to every layer below and then
502'd the student's rep. `llm.complete_json` is what turns those into a retry.
"""

import json

import pytest
from fastapi.testclient import TestClient

import app.llm as llm
from app import framework
from app.main import app

client = TestClient(app)

GOOD = json.dumps({"ok": True})


@pytest.fixture
def crit_ids():
    return [c["id"] for c in framework.criteria_for_domains(["marketing"])[:4]]


def test_retries_unparseable_reply_then_succeeds(monkeypatch):
    """A dropped comma on the first attempt must not cost the caller the call."""
    calls = []

    def flaky(system, user, **kw):
        calls.append(kw.get("max_tokens"))
        return "here you go: {broken json," if len(calls) == 1 else GOOD

    monkeypatch.setattr(llm, "complete", flaky)
    assert llm.complete_json("s", "u", max_tokens=1000) == {"ok": True}
    # Retried once, at the SAME ceiling — the cap wasn't the problem here.
    assert calls == [1000, 1000]


def test_truncated_reply_is_retried_with_a_bigger_ceiling(monkeypatch):
    """Re-asking at the ceiling that just truncated would only truncate again."""
    calls = []

    def flaky(system, user, **kw):
        cap = kw.get("max_tokens")
        calls.append(cap)
        if len(calls) == 1:
            raise llm.LLMTruncated("hit the cap")
        return GOOD

    monkeypatch.setattr(llm, "complete", flaky)
    assert llm.complete_json("s", "u", max_tokens=4096) == {"ok": True}
    assert calls == [4096, 8192]


def test_gives_up_rather_than_looping(monkeypatch):
    """A model failing every time is an outage to surface, not a loop to grind."""
    calls = []

    def always_bad(system, user, **kw):
        calls.append(1)
        return "no json here"

    monkeypatch.setattr(llm, "complete", always_bad)
    with pytest.raises(llm.LLMError):
        llm.complete_json("s", "u", retries=1)
    assert len(calls) == 2  # the attempt plus one retry, and no more


def test_truncation_is_detected_from_stop_reason(monkeypatch):
    """`stop_reason == "max_tokens"` is the only reliable truncation signal.

    Without this check a cut-off reply reached `parse_json_object`, which sliced
    to the last `}` it could find and reported a comma error — pointing at the
    wrong bug, and doing it in a message the student saw verbatim.
    """
    class _Block:
        type = "text"
        text = '{"partial": "cut off here'

    class _Msg:
        stop_reason = "max_tokens"
        content = [_Block()]

    class _Messages:
        def create(self, **kw):
            return _Msg()

    class _Client:
        messages = _Messages()

    monkeypatch.setattr(llm, "_get_client", lambda: _Client())
    with pytest.raises(llm.LLMTruncated):
        llm.complete("s", "u", max_tokens=100)


def test_scoring_failure_does_not_leak_parser_internals(monkeypatch, crit_ids):
    """A student who just recorded a rep should get a next step, not a stack trace."""
    monkeypatch.setattr(llm, "complete", lambda *a, **k: "the model rambled instead")

    r = client.post(
        "/api/score-content",
        json={
            "scenario": "...", "criteria_ids": crit_ids,
            "response": "I work at BrightPath...",
            "followup_questions": ["q"], "followup_answer": "because BrightPath",
        },
    )
    assert r.status_code == 502
    detail = r.json()["detail"]
    assert "JSON" not in detail and "json" not in detail
    assert "delimiter" not in detail
    # It must say the recording survived — that is the part they're worried about.
    assert "recording" in detail.lower()


def test_scoring_recovers_from_a_single_bad_reply(monkeypatch, crit_ids):
    """The end-to-end shape of the fix: one bad reply, still a graded rep."""
    calls = []

    def flaky(system, user, **kw):
        calls.append(1)
        if len(calls) == 1:
            return "{ this is not valid json"
        return json.dumps({
            "performance_indicators": [
                {"criterion_id": cid, "level": "proficient", "points": 8,
                 "headline": "h", "feedback": "fb", "evidence": [], "gaps": [],
                 "suggestion": "s"}
                for cid in crit_ids
            ],
            "analytical": {
                "framing": {"score": 3, "justification": "", "evidence": None},
                "solution_quality": {"score": 3, "justification": "", "evidence": None},
                "pi_application": {"score": 3, "justification": "", "evidence": None},
                "creativity": {"bonus": 0.0, "justification": "", "evidence": None},
            },
            "presentation": {"score": 3, "notes": ""},
            "summary": "ok", "strengths": [], "improvements": [], "followup_feedback": "",
        })

    monkeypatch.setattr(llm, "complete", flaky)
    r = client.post(
        "/api/score-content",
        json={
            "scenario": "...", "criteria_ids": crit_ids,
            "response": "I work at BrightPath...",
            "followup_questions": ["q"], "followup_answer": "because BrightPath",
        },
    )
    assert r.status_code == 200
    assert len(r.json()["scores"]) == len(crit_ids)
    assert len(calls) == 2


# --- spend guards: cap the start of work, never the finish --------------------


def test_daily_cap_still_grades_a_rep_recorded_before_it_landed(monkeypatch, crit_ids):
    """The cap must not destroy a session it already paid for.

    By the time a student reaches grading, the scenario has been generated and
    the audio transcribed — the money is gone. Refusing here saves nothing and
    loses them a rep they prepared for, recorded, and submitted.
    """
    from app import ratelimit

    monkeypatch.setattr(ratelimit, "_DAILY_CAP", 10)
    monkeypatch.setattr(ratelimit, "_day", {"date": None, "count": 0})

    def graded(system, user, **kw):
        return json.dumps({
            "performance_indicators": [
                {"criterion_id": cid, "level": "proficient", "points": 8,
                 "headline": "h", "feedback": "f", "evidence": [], "gaps": [], "suggestion": "s"}
                for cid in crit_ids
            ],
            "analytical": {
                "framing": {"score": 3, "justification": "", "evidence": None},
                "solution_quality": {"score": 3, "justification": "", "evidence": None},
                "pi_application": {"score": 3, "justification": "", "evidence": None},
                "creativity": {"bonus": 0.0, "justification": "", "evidence": None},
            },
            "presentation": {"score": 3, "notes": ""},
            "summary": "", "strengths": [], "improvements": [], "followup_feedback": "",
        })

    monkeypatch.setattr(llm, "complete", graded)
    body = {
        "scenario": "...", "criteria_ids": crit_ids, "response": "...",
        "followup_questions": [], "followup_answer": "",
    }

    # Spend the day's budget, then confirm a NEW session is refused...
    for _ in range(10):
        client.post("/api/score-content", json=body)
    assert client.post("/api/scenario", json={"event": "", "level": "district", "mode": "learn"}).status_code == 503

    # ...while a submit still goes through, inside the grace band.
    assert client.post("/api/score-content", json=body).status_code == 200


def test_burst_limit_is_sized_for_a_shared_school_ip():
    """A classroom on one NAT is the target usage, not an abusive client."""
    from app import ratelimit

    # Whatever the tuning, a submit must survive a burst far larger than the
    # start limit — that is the whole point of the completion ceiling.
    assert ratelimit._MAX_PER_WINDOW >= 60
    assert ratelimit._MAX_PER_WINDOW * ratelimit._COMPLETION_MULTIPLIER > ratelimit._MAX_PER_WINDOW


def test_startup_sizes_the_threadpool_for_io_bound_work():
    """Blocking provider calls share one pool with every sync endpoint.

    At the default of 40, enough concurrent transcriptions (each holding its
    thread for the length of a recording) would starve every plain `def` route in
    main.py — including the ones that just read local JSON.
    """
    import anyio
    import anyio.to_thread

    from app.main import _THREADPOOL_SIZE, _lifespan, app as fastapi_app

    async def run():
        async with _lifespan(fastapi_app):
            return anyio.to_thread.current_default_thread_limiter().total_tokens

    assert anyio.run(run) == _THREADPOOL_SIZE
    assert _THREADPOOL_SIZE > 40
