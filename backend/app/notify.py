"""Best-effort email notification for user feedback.

When a RESEND_API_KEY is configured, each submitted feedback is emailed to the
operator via Resend's HTTPS API. We use HTTPS (not SMTP) because Render's free
tier blocks outbound SMTP ports. Sending is best-effort: any failure is logged
and swallowed so it can never break the /api/feedback request. Call this from a
background task — the urllib POST is blocking.

Privacy: feedback text is operator-facing and submitted voluntarily; we never
include transcripts, responses, or scenario content here (the endpoint doesn't
have them).
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request

from . import config

log = logging.getLogger("uvicorn.error")

_RESEND_URL = "https://api.resend.com/emails"


def send_feedback_email(rating: int | None, email: str, page: str, message: str) -> None:
    """Email a single piece of feedback to the operator. No-op if unconfigured."""
    if not config.RESEND_API_KEY:
        return
    rating_label = f"{'★' * rating}{'☆' * (5 - rating)} ({rating}/5)" if rating else "—"
    reply_to = email.strip() or "(not provided)"
    body = (
        f"New PI Coach feedback\n\n"
        f"Rating:  {rating_label}\n"
        f"Page:    {page or '—'}\n"
        f"From:    {reply_to}\n\n"
        f"Message:\n{message or '(no message)'}\n"
    )
    payload = {
        "from": config.FEEDBACK_EMAIL_FROM,
        "to": [config.FEEDBACK_EMAIL_TO],
        "subject": f"PI Coach feedback ({rating_label})",
        "text": body,
    }
    # If the user left their email, set reply-to so you can answer them directly.
    if email.strip():
        payload["reply_to"] = email.strip()

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        _RESEND_URL,
        data=data,
        headers={
            "Authorization": f"Bearer {config.RESEND_API_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status >= 300:
                log.warning("feedback email: Resend returned HTTP %s", resp.status)
    except urllib.error.HTTPError as exc:  # surface Resend's reason (e.g. 403 body)
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")
        except Exception:
            pass
        log.warning("feedback email failed: HTTP %s %s — %s", exc.code, exc.reason, detail)
    except Exception as exc:  # best-effort; never break the request
        log.warning("feedback email failed: %s", exc)
