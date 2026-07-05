"""Free-text request interpretation and criteria selection.

The user types what they want to practice ("marketing for a restaurant"); we
interpret that into our business domains + an industry, then hand the criteria in
those domains to scenario generation, which selects the 4-6 that best fit and can
be assessed together. Selection is OUR logic over OUR framework — there is no
fixed event-to-criteria blueprint.
"""

from __future__ import annotations

from . import framework, llm, prompts

# When the model's interpretation yields no usable domains (but the request is in
# scope), fall back to a broad, coherent general-business spread so we never block
# a valid-but-vague request.
_DEFAULT_DOMAINS = [
    "strategic_management",
    "communication",
    "marketing",
    "financial_analysis",
    "customer_relations",
    "operations",
]

# Keep the candidate pool handed to generation bounded (it is sent in the prompt).
_MAX_CANDIDATES = 70


class OutOfScope(Exception):
    """Raised when the request isn't a business role-play topic. Carries a
    friendly redirect message for the user."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def interpret_request(request: str) -> dict:
    """Interpret free text into {topic, industry, domain_ids}. Raises OutOfScope
    (with a friendly message) for clearly non-business requests. Defensive: any
    parsing/validation slip degrades to a sensible in-scope default rather than
    failing the user."""
    system, user = prompts.build_interpretation_prompt(request, framework.domains())
    raw = llm.complete(system, user, max_tokens=500)
    data = llm.parse_json_object(raw)

    if data.get("in_scope") is False:
        msg = str(data.get("redirect_message", "")).strip() or (
            'Try a business topic — for example "marketing for a coffee shop" or '
            '"a staffing problem in retail."'
        )
        raise OutOfScope(msg)

    valid = framework.domain_ids()
    domain_ids = [d for d in data.get("domain_ids", []) if d in valid]
    if not domain_ids:
        domain_ids = _DEFAULT_DOMAINS

    topic = str(data.get("topic", "")).strip() or request.strip()
    industry = str(data.get("industry", "")).strip() or "general business"
    return {"topic": topic, "industry": industry, "domain_ids": domain_ids}


def candidate_pool(domain_ids: list[str]) -> list[dict]:
    """The criteria generation may choose from, for the interpreted domains."""
    pool = framework.criteria_for_domains(domain_ids)
    if not pool:  # extreme fallback — should not happen with validated ids
        pool = framework.criteria_for_domains(_DEFAULT_DOMAINS)
    return pool[:_MAX_CANDIDATES]


def resolve_selection(criteria_ids: list[str], pool: list[dict]) -> list[dict]:
    """Turn the model's chosen ids into pinned framework criteria (4-6).

    - Keep only ids the model was actually offered (the pool), preserving order.
    - Drop duplicates, cap at 6.
    - If the model returned too few valid ids, top up from the pool so a role-play
      always has a coherent set to grade against.
    """
    pool_ids = [c["id"] for c in pool]
    pool_set = set(pool_ids)
    seen: set[str] = set()
    chosen: list[str] = []
    for cid in criteria_ids:
        if cid in pool_set and cid not in seen:
            chosen.append(cid)
            seen.add(cid)
    for cid in pool_ids:  # top up toward a minimum of 4 if the model under-picked
        if len(chosen) >= 4:
            break
        if cid not in seen:
            chosen.append(cid)
            seen.add(cid)
    chosen = chosen[:6]
    return framework.get_criteria(chosen)
