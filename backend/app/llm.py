"""Thin Anthropic wrapper + defensive JSON parsing.

The frontend never calls Anthropic — only this backend does, with the key read
from the environment. Keep this module small: build a client lazily, make one
text completion, and parse model JSON defensively (the roadmap §7 rule).
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import anthropic

from .config import MODEL, SCENARIO_MODEL, SCORING_MODEL  # noqa: F401  (re-exported for callers)

log = logging.getLogger("uvicorn.error")


class LLMNotConfigured(RuntimeError):
    """Raised when no Anthropic API key is configured on the backend."""


class LLMError(RuntimeError):
    """Raised when the provider call or response parsing fails."""


class LLMTruncated(LLMError):
    """Raised when the model hit `max_tokens` and the reply is cut off mid-JSON.

    Split out from the generic parse failure because the two need different
    responses: a truncated reply is a capacity problem we caused (raise the cap),
    while a malformed one is a model slip that a retry usually clears. Before
    this existed, truncation surfaced as "Could not parse model JSON: Expecting
    ',' delimiter" — a message that pointed at the wrong bug and reached the
    student verbatim.
    """


_client: anthropic.Anthropic | None = None


def _get_client() -> anthropic.Anthropic:
    if not os.getenv("ANTHROPIC_API_KEY"):
        raise LLMNotConfigured("ANTHROPIC_API_KEY is not set on the backend.")
    global _client
    if _client is None:
        _client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from env
    return _client


def complete(system: str, user: str, *, model: str | None = None, max_tokens: int = 2048) -> str:
    """Run one non-streaming completion and return the concatenated text.

    `model` selects the job-specific model (SCENARIO_MODEL / SCORING_MODEL); it
    falls back to the shared MODEL. We pin `thinking` OFF: Sonnet 5 turns adaptive
    thinking ON by default when the field is omitted (Sonnet 4.6 did not), which
    would add latency and let thinking tokens eat into `max_tokens` and truncate
    the JSON we parse. Disabling it preserves the old fast, JSON-only behavior.
    """
    client = _get_client()
    try:
        msg = client.messages.create(
            model=model or MODEL,
            max_tokens=max_tokens,
            thinking={"type": "disabled"},
            system=system,
            messages=[{"role": "user", "content": user}],
        )
    except anthropic.APIError as e:  # network, rate-limit, 5xx, etc.
        raise LLMError(f"Anthropic API error: {e}") from e
    if getattr(msg, "stop_reason", None) == "max_tokens":
        raise LLMTruncated(f"Model reply hit the {max_tokens}-token cap and was cut off.")
    return "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()


def complete_vision(
    system: str,
    images: list[tuple[str, str]],
    instruction: str,
    *,
    model: str | None = None,
    max_tokens: int = 1024,
) -> str:
    """One completion over a BATCH of images plus a text instruction.

    `images` is a list of ``(media_type, base64_data)`` — already downscaled by the
    caller. Batching matters here: one call carrying 15 frames costs a fraction of
    15 calls carrying one frame each, because the system prompt and instruction are
    charged once instead of fifteen times, and it collapses fifteen round-trips of
    latency into one.

    Images are placed BEFORE the instruction, which is the documented ordering for
    multi-image prompts, and each is labelled so the model can key its per-frame
    output back to a frame index.
    """
    client = _get_client()
    content: list[dict[str, Any]] = []
    for i, (media_type, data) in enumerate(images):
        content.append({"type": "text", "text": f"Frame {i}:"})
        content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": media_type, "data": data},
        })
    content.append({"type": "text", "text": instruction})

    try:
        msg = client.messages.create(
            model=model or MODEL,
            max_tokens=max_tokens,
            thinking={"type": "disabled"},
            system=system,
            messages=[{"role": "user", "content": content}],
        )
    except anthropic.APIError as e:
        raise LLMError(f"Anthropic API error: {e}") from e
    if getattr(msg, "stop_reason", None) == "max_tokens":
        raise LLMTruncated(f"Model reply hit the {max_tokens}-token cap and was cut off.")
    return "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()


def parse_json_object(text: str) -> dict[str, Any]:
    """Parse the first JSON object out of model text.

    Defensive per roadmap §7: strip code fences, then slice from the first ``{``
    to the last ``}`` before json.loads. Raises LLMError on failure so callers
    can surface a clean 502 instead of leaking a stack trace.
    """
    t = text.strip()
    if t.startswith("```"):
        # drop a leading ```json / ``` fence and any trailing fence
        t = t.split("```", 2)[1] if t.count("```") >= 2 else t.strip("`")
        if t.lstrip().lower().startswith("json"):
            t = t.lstrip()[4:]
    start, end = t.find("{"), t.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise LLMError("Model did not return a JSON object.")
    try:
        # strict=False tolerates literal control characters inside strings. Models
        # regularly emit a real newline instead of \n when a field is specified as
        # multi-paragraph prose (the scenario "situation" asks for 2-3 paragraphs),
        # and strict parsing turns that stylistic slip into a 502 on a student's rep.
        # Measured on claude-sonnet-5: 6 of 8 scenario generations failed this way.
        return json.loads(t[start : end + 1], strict=False)
    except json.JSONDecodeError as e:
        raise LLMError(f"Could not parse model JSON: {e}") from e


def complete_json(
    system: str,
    user: str,
    *,
    model: str | None = None,
    max_tokens: int = 2048,
    retries: int = 1,
) -> dict[str, Any]:
    """`complete` + `parse_json_object`, with a bounded retry on a bad reply.

    WHY THIS EXISTS. The Anthropic SDK already retries transport-level failures
    (429s, 5xx, dropped connections) on its own, so those are covered. What it
    cannot retry is the failure that actually reached students: a 200 OK whose
    body is not parseable JSON — the model dropped a comma, wrapped the object in
    prose, or ran into `max_tokens` and stopped mid-string. Every one of those
    turned into a 502 and cost the student the rep they had just recorded, even
    though the very same request succeeds on a second attempt the overwhelming
    majority of the time.

    Truncation is retried differently from a malformed body: repeating the call
    with the same ceiling would only truncate again, so the cap is doubled for the
    retry. Everything else is a straight re-ask.

    `retries` is deliberately small. This sits in the request path of a student
    waiting on a score, and a model that fails twice in a row is an outage to
    report, not a loop to grind on.
    """
    attempt = 0
    cap = max_tokens
    while True:
        try:
            return parse_json_object(complete(system, user, model=model, max_tokens=cap))
        except LLMTruncated as e:
            if attempt >= retries:
                raise
            cap = min(cap * 2, 16000)
            log.warning("LLM reply truncated (%s); retrying at max_tokens=%d", e, cap)
        except LLMError as e:
            if attempt >= retries:
                raise
            log.warning("LLM returned unparseable JSON (%s); retrying", e)
        attempt += 1
