"""Deterministic arithmetic verification for quantitative role-plays.

The rule for quantitative events (accounting, finance): **the model may set up a
calculation, but it may never be trusted to do the arithmetic.** LLMs are strong
at choosing the right formula and weak at computing it reliably — so for these
events the grader hands us each calculation as a raw expression (e.g.
`"(50000 - 30000) / 50000 * 100"`) plus the value the student claimed, and this
module recomputes it with Python. The recomputed number is authoritative; that is
what feedback shows, so the app can never tell a student their correct math is
wrong (or bless a wrong number) on the model's say-so.

The evaluator is a tiny, safe arithmetic interpreter over Python's AST: numeric
literals and + - * / // % ** with parentheses and unary minus, plus a short
whitelist of pure functions (round/abs/min/max/sum). No names, attributes, calls
to anything else, comprehensions, or indexing are allowed — so an expression can
never reach the interpreter, the filesystem, or the network.
"""

from __future__ import annotations

import ast
import math
import operator

_BIN_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}
_UNARY_OPS = {ast.UAdd: operator.pos, ast.USub: operator.neg}
_FUNCS = {
    "round": round,
    "abs": abs,
    "min": min,
    "max": max,
    "sum": sum,
}
# Guard against absurd exponents that could hang the process (e.g. 9**9**9).
_MAX_POW_EXP = 1000


class MathError(ValueError):
    """Raised when an expression is unsafe, malformed, or not computable."""


def _eval(node: ast.AST) -> float:
    if isinstance(node, ast.Expression):
        return _eval(node.body)
    if isinstance(node, ast.Constant):
        if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
            raise MathError("only numbers are allowed")
        return node.value
    if isinstance(node, ast.BinOp):
        op = _BIN_OPS.get(type(node.op))
        if op is None:
            raise MathError(f"operator {type(node.op).__name__} is not allowed")
        left, right = _eval(node.left), _eval(node.right)
        if isinstance(node.op, ast.Pow) and abs(right) > _MAX_POW_EXP:
            raise MathError("exponent too large")
        return op(left, right)
    if isinstance(node, ast.UnaryOp):
        op = _UNARY_OPS.get(type(node.op))
        if op is None:
            raise MathError("unary operator not allowed")
        return op(_eval(node.operand))
    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name) or node.func.id not in _FUNCS:
            raise MathError("only round/abs/min/max/sum are allowed")
        if node.keywords:
            raise MathError("keyword arguments are not allowed")
        return _FUNCS[node.func.id](*[_eval(a) for a in node.args])
    raise MathError(f"unsupported syntax: {type(node).__name__}")


def evaluate(expression: str) -> float:
    """Safely evaluate an arithmetic expression string to a number.

    Raises MathError for anything outside the allowed grammar, division by zero,
    or a non-finite result.
    """
    expr = (expression or "").strip()
    if not expr or len(expr) > 400:
        raise MathError("empty or over-long expression")
    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError as e:
        raise MathError(f"could not parse: {e}") from e
    try:
        value = _eval(tree)
    except ZeroDivisionError as e:
        raise MathError("division by zero") from e
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise MathError("did not evaluate to a number")
    if not math.isfinite(value):
        raise MathError("result is not a finite number")
    return float(value)


def _close(a: float, b: float) -> bool:
    """Whether the claimed and computed values agree, allowing for rounding.

    Absolute tolerance covers cents/rounded percentages; relative tolerance covers
    large dollar figures rounded to the nearest unit.
    """
    return math.isclose(a, b, rel_tol=0.01, abs_tol=0.5)


def verify_check(raw: dict) -> dict:
    """Verify one model-supplied calculation. Returns a normalized result dict:

        {label, expression, claimed, computed, ok, note}

    `computed` is Python's authoritative result (None if the expression was
    unusable). `ok` is True/False when a claim can be compared, else None.
    """
    label = str(raw.get("label", "")).strip()
    expression = str(raw.get("expression", "")).strip()
    unit = str(raw.get("unit", "")).strip()
    claimed_raw = raw.get("claimed", None)
    claimed = claimed_raw if isinstance(claimed_raw, (int, float)) and not isinstance(claimed_raw, bool) else None

    result: dict = {"label": label, "expression": expression, "unit": unit,
                    "claimed": claimed, "computed": None, "ok": None, "note": ""}
    if not expression:
        result["note"] = "No expression to verify."
        return result
    try:
        computed = evaluate(expression)
    except MathError as e:
        result["note"] = f"Couldn't verify this calculation ({e})."
        return result

    computed = round(computed, 4)
    result["computed"] = computed
    if claimed is not None:
        result["ok"] = _close(float(claimed), computed)
    return result


# Guardrail on how many checks we surface, so a chatty model can't bury the user.
_MAX_CHECKS = 8


def _dedup_key(check: dict) -> str:
    """Two checks are 'the same' if they compute the same expression (ignoring
    whitespace) — this drops the model's duplicate/contradictory variants."""
    return "".join((check.get("expression") or "").split())


def verify_all(raw_checks: list) -> list[dict]:
    """Verify model-supplied checks: skip malformed entries, drop duplicate
    expressions (which is how contradictory 'claimed vs correct' pairs show up),
    and cap the count."""
    out: list[dict] = []
    seen: set[str] = set()
    for raw in raw_checks or []:
        if not isinstance(raw, dict):
            continue
        result = verify_check(raw)
        key = _dedup_key(result)
        if key and key in seen:
            continue  # already verified this exact expression
        seen.add(key)
        out.append(result)
        if len(out) >= _MAX_CHECKS:
            break
    return out
