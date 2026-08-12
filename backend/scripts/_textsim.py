"""Small text-similarity helpers shared by the build scripts. Stdlib only.

Lives on its own so that gen_terms.py can dedupe its own output WITHOUT importing
check_independence.py — the module that reads DECA's PI list. Terms are authored
blind and audited afterwards (see both scripts' docstrings); keeping the authoring
path structurally unable to reach the reference file is how that invariant is kept
honest rather than merely intended.
"""

from __future__ import annotations

import re
from difflib import SequenceMatcher

# Words too common to carry evidence of copying. Kept deliberately small: the more
# we strip, the more we flatter ourselves.
_STOP = {
    "a", "an", "and", "are", "as", "at", "be", "by", "can", "for", "from", "how",
    "in", "into", "is", "it", "its", "of", "on", "or", "that", "the", "their",
    "them", "they", "this", "to", "use", "used", "using", "was", "what", "when",
    "which", "who", "will", "with", "you", "your",
}

_WORD = re.compile(r"[a-z0-9]+")


def tokens(text: str) -> list[str]:
    """Normalized content words, in order."""
    return [w for w in _WORD.findall(text.lower()) if w not in _STOP and len(w) > 1]


def jaccard(a: set[str], b: set[str]) -> float:
    """Bag-of-words overlap. Topical, not evidential — two people writing about
    break-even will both say "fixed costs"."""
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def ratio(a: list[str], b: list[str]) -> float:
    """Sequence similarity over token lists."""
    return SequenceMatcher(None, a, b, autojunk=False).ratio()


def longest_run(a: list[str], b: list[str]) -> int:
    """Longest run of consecutive content words shared by both — the signal that
    separates copied phrasing from a shared subject."""
    return SequenceMatcher(None, a, b, autojunk=False).find_longest_match(0, len(a), 0, len(b)).size
