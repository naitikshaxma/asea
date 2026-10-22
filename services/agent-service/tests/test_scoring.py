"""Deterministic scoring (app/verification/scoring.py) and POST /api/v1/verify/score."""

import json
import random
from pathlib import Path

import pytest

from app.verification.contract import Finding
from app.verification.policy import PolicyConfig, policy_hash
from app.verification.scoring import score_findings
from app.verification.static_analysis import run_static_analysis
from tests.fixture_support import CASES, load_case

DEFAULT_POLICY_FILE = (
    Path(__file__).resolve().parents[3] / "packages" / "contracts" / "schemas" / "default-policy.json"
)
# Pinned on both sides: services/api/tests/policy/policyService.test.ts expects the same hash
DEFAULT_POLICY_HASH = "3d2ba0a91b23ddfc65968bb2d62f08bd6e5ece14c832ae5f07f133eb75ac1391"

# The demo fixtures were designed to land in distinct bands under the default policy
EXPECTED = {
    "clean": (100, "allow"),
    "no_tests": (85, "review"),
    "missing_auth": (65, "high_risk"),
    "secret_and_sql": (15, "block"),
}


@pytest.fixture
def default_policy() -> PolicyConfig:
    return PolicyConfig.model_validate(json.loads(DEFAULT_POLICY_FILE.read_text(encoding="utf-8")))


def finding(fid: str, severity: str, category: str = "static", source: str = "deterministic") -> Finding:
    return Finding(
        id=fid,
        category=category,
        severity=severity,
        title=f"{severity} finding",
        file="app.py",
        line=1,
        evidence=[],
        source=source,
        rule_id=f"RULE-{fid}",
        remediation="",
    )


def with_changes(policy: PolicyConfig, **sections) -> PolicyConfig:
    data = policy.model_dump()
    for key, value in sections.items():
        data[key] = {**data[key], **value} if isinstance(value, dict) else value
    return PolicyConfig.model_validate(data)


def test_every_fixture_has_an_expected_verdict():
    assert set(EXPECTED) == set(CASES)


@pytest.mark.parametrize("case", sorted(EXPECTED))
def test_fixture_cases_get_their_expected_score_and_verdict(case, default_policy, tmp_path):
    request, _ = load_case(case)
    static = run_static_analysis(
        request,
        auth_decorators={"login_required"},
        semgrep_command="semgrep-not-installed",
        semgrep_ruleset=tmp_path / "missing.json",
        semgrep_rules_lock=tmp_path / "missing.lock.json",
        semgrep_timeout_seconds=5,
    )
    result = score_findings(static.findings, default_policy)
    assert (result.score, result.verdict) == EXPECTED[case]
    # Every finding is in the breakdown, largest deduction first
    assert sorted(item.finding_id for item in result.breakdown) == sorted(f.id for f in static.findings)
    deductions = [item.deduction for item in result.breakdown]
    assert deductions == sorted(deductions, reverse=True)


def test_secret_and_sql_breakdown_and_cap(default_policy):
    result = score_findings([finding("sql", "high"), finding("secret", "critical")], default_policy)
    assert result.total_deduction == 85
    assert result.raw_score == 15
    assert [(i.finding_id, i.deduction) for i in result.breakdown] == [("secret", 50), ("sql", 35)]
    # The critical cap held but did not lower the score (15 is already below 39)
    assert [c.model_dump() for c in result.caps_applied] == [
        {"id": "critical_present", "severity": "critical", "min_count": 1, "count": 1, "max_score": 39, "lowered_score": False}
    ]
    assert result.verdict == "block"


def test_no_findings_scores_100_allow(default_policy):
    result = score_findings([], default_policy)
    assert (result.score, result.verdict, result.raw_score, result.breakdown, result.caps_applied) == (100, "allow", 100, [], [])


def test_multipliers_apply_and_rounding_is_half_up(default_policy):
    # high (35) x llm (0.5) = 17.5 -> 82.5 -> 83 (round-half-to-even would give 82)
    result = score_findings([finding("a", "high", source="llm")], default_policy)
    item = result.breakdown[0]
    assert (item.severity_weight, item.category_multiplier, item.source_multiplier, item.deduction) == (35, 1, 0.5, 17.5)
    assert (result.raw_score, result.score, result.verdict) == (82.5, 83, "review")

    weighted = with_changes(default_policy, category_multipliers={"test_gap": 0.3333})
    result = score_findings([finding("gap", "medium", category="test_gap")], weighted)
    assert result.breakdown[0].deduction == 4.9995  # 15 x 0.3333, rounded to 4 decimals
    assert result.score == 95


def test_cap_lowers_the_score_when_it_is_above_max_score(default_policy):
    lenient = with_changes(default_policy, severity_weights={"high": 5})
    result = score_findings([finding("a", "high"), finding("b", "high")], lenient)
    assert result.raw_score == 90
    assert result.score == 59
    assert result.verdict == "high_risk"
    assert result.caps_applied[0].id == "two_or_more_high"
    assert result.caps_applied[0].lowered_score is True


def test_score_is_clamped_to_zero(default_policy):
    result = score_findings([finding(str(i), "critical") for i in range(3)], default_policy)
    assert result.raw_score == -50
    assert (result.score, result.verdict) == (0, "block")


def test_verdict_bands_are_inclusive_lower_bounds(default_policy):
    def scored(deduction: float) -> tuple[int, str]:
        policy = with_changes(default_policy, severity_weights={"low": deduction}, caps=[])
        result = score_findings([finding("x", "low")], policy)
        return result.score, result.verdict

    assert scored(10) == (90, "allow")
    assert scored(11) == (89, "review")
    assert scored(30) == (70, "review")
    assert scored(31) == (69, "high_risk")
    assert scored(60) == (40, "high_risk")
    assert scored(61) == (39, "block")


def test_result_does_not_depend_on_finding_order(default_policy):
    findings = [
        finding("a", "high"),
        finding("b", "medium", category="test_gap"),
        finding("c", "low", source="llm"),
        finding("d", "medium"),
    ]
    expected = score_findings(findings, default_policy)
    shuffled = findings[:]
    for seed in range(5):
        random.Random(seed).shuffle(shuffled)
        assert score_findings(shuffled, default_policy) == expected
    # Equal deductions are ordered by finding id
    assert [i.finding_id for i in expected.breakdown] == ["a", "b", "d", "c"]


def test_policy_hash_is_pinned_and_ignores_int_float_spelling(default_policy):
    assert policy_hash(default_policy) == DEFAULT_POLICY_HASH
    as_floats = json.loads(DEFAULT_POLICY_FILE.read_text(encoding="utf-8"))
    as_floats["severity_weights"] = {k: float(v) for k, v in as_floats["severity_weights"].items()}
    assert policy_hash(PolicyConfig.model_validate(as_floats)) == DEFAULT_POLICY_HASH
    assert policy_hash(with_changes(default_policy, severity_weights={"low": 6})) != DEFAULT_POLICY_HASH
    assert score_findings([], default_policy).policy_hash == DEFAULT_POLICY_HASH


@pytest.mark.parametrize(
    "change, message",
    [
        ({"verdict_bands": {"block": 5}}, "block must be 0"),
        ({"verdict_bands": {"review": 95}}, "must decrease"),
        ({"severity_weights": {"low": 1.23456}}, "4 decimal places"),
        ({"severity_weights": {"low": -1}}, "greater than or equal to 0"),
    ],
)
def test_invalid_policies_are_rejected(default_policy, change, message):
    data = default_policy.model_dump()
    for key, value in change.items():
        data[key] = {**data[key], **value}
    with pytest.raises(ValueError, match=message):
        PolicyConfig.model_validate(data)


def test_duplicate_cap_ids_are_rejected(default_policy):
    data = default_policy.model_dump()
    data["caps"] = [data["caps"][0], data["caps"][0]]
    with pytest.raises(ValueError, match="unique"):
        PolicyConfig.model_validate(data)


def test_score_endpoint(client, default_policy):
    body = {
        "findings": [finding("secret", "critical").model_dump()],
        "policy": default_policy.model_dump(),
    }
    response = client.post("/api/v1/verify/score", json=body)
    assert response.status_code == 200
    data = response.json()
    assert (data["score"], data["verdict"], data["policy_hash"]) == (39, "block", DEFAULT_POLICY_HASH)
    assert data["caps_applied"][0]["lowered_score"] is True  # 50 -> capped at 39


def test_score_endpoint_rejects_an_invalid_policy(client, default_policy):
    policy = default_policy.model_dump()
    policy["verdict_bands"]["block"] = 10
    response = client.post("/api/v1/verify/score", json={"findings": [], "policy": policy})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"


def test_score_endpoint_requires_the_internal_token(anonymous_client, default_policy):
    response = anonymous_client.post("/api/v1/verify/score", json={"findings": [], "policy": default_policy.model_dump()})
    assert response.status_code == 401
