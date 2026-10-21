"""Integrity of the static-analysis fixtures: each diff applies to demo_app and
each expected finding points at a line the diff adds."""

import pytest
from unidiff import PatchSet

from tests.fixture_support import CASES, DEMO_APP, DIFFS, apply_diff, load_case


def test_expected_cases_exist():
    assert CASES == ["clean", "missing_auth", "no_tests", "secret_and_sql"]
    for case in CASES:
        assert (DIFFS / f"{case}.expected_findings.json").is_file()


def test_clean_case_expects_no_findings():
    _, expected = load_case("clean")
    assert expected == []


@pytest.mark.parametrize("case", CASES)
def test_diff_applies_and_expected_findings_are_on_added_lines(case):
    request, expected = load_case(case)
    added = {
        (patched.path, line.target_line_no)
        for patched in PatchSet(request.unified_diff)
        for hunk in patched
        for line in hunk
        if line.is_added
    }
    assert request.changed_files, "every fixture diff changes at least one file"
    for finding in expected:
        assert (finding["file"], finding["line"]) in added, finding


def test_apply_diff_rejects_a_diff_that_does_not_match(tmp_path):
    (tmp_path / "services").mkdir()
    (tmp_path / "services" / "projects.py").write_text("something else\n", encoding="utf-8")
    diff = (DIFFS / "no_tests.diff").read_text(encoding="utf-8")

    with pytest.raises(ValueError, match="does not match the diff"):
        apply_diff(tmp_path, diff)
    assert apply_diff(DEMO_APP, diff)  # and applies to the real base
