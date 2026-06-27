"""Phase 1 acceptance check.

Given an event code, print its instructional areas and the full PI pool.

    uv run python scripts/pi_lookup.py PMK
"""

import sys
from pathlib import Path

# Allow running as a plain script (not a module) from the backend root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.data_loader import (  # noqa: E402
    EventNotFoundError,
    get_event,
    get_instructional_areas,
    get_pi_pool,
)


def main(code: str) -> int:
    try:
        event = get_event(code)
    except EventNotFoundError:
        print(f"Unknown event code: {code!r}", file=sys.stderr)
        return 1

    print(f"{event['code']} — {event['name']} (level: {event['level']}, surfaces {event['pi_count']} PIs)")
    print()
    print("Instructional areas:")
    for area in get_instructional_areas(code):
        print(f"  {area['id']}  {area['name']}")
    print()

    pool = get_pi_pool(code)
    print(f"PI pool ({len(pool)} indicators):")
    for pi in pool:
        print(f"  [{pi['area']}] {pi['id']}: {pi['text']}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python scripts/pi_lookup.py <EVENT_CODE>", file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))
