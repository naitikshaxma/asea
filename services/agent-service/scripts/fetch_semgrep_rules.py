"""Download the pinned Semgrep ruleset into rules/semgrep/ (gitignored).

The rules are not committed: they are under the Semgrep Rules License v1.0
(internal business use only, no redistribution). This repository commits
only rules/semgrep/p-python.lock.json: the semgrep-rules commit, the rule ids
of the registry pack p/python, and the sha256 of the assembled ruleset.

    python scripts/fetch_semgrep_rules.py            # download + verify the pin
    python scripts/fetch_semgrep_rules.py --update --commit <sha>
                                                     # re-pin (fetches the pack's
                                                     # rule ids from the registry)

Only this script uses the network; the agent service runs Semgrep offline on
the downloaded file and refuses a file whose sha256 differs from the lock.
"""

import argparse
import datetime
import hashlib
import io
import json
import sys
import tarfile
import urllib.request
from pathlib import Path, PurePosixPath
from typing import Any

import yaml

SERVICE_DIR = Path(__file__).resolve().parents[1]
RULES_DIR = SERVICE_DIR / "rules" / "semgrep"
LOCK_FILE = RULES_DIR / "p-python.lock.json"
RULESET_FILE = RULES_DIR / "p-python.json"

REPOSITORY = "https://github.com/semgrep/semgrep-rules"
TARBALL_URL = "https://codeload.github.com/semgrep/semgrep-rules/tar.gz/{commit}"
PACK = "p/python"
PACK_URL = "https://semgrep.dev/c/p/python"
LICENSE = (
    "Semgrep Rules License v1.0 (https://semgrep.dev/legal/rules-license): internal business use only; "
    "the rules are downloaded by this script and not redistributed in this repository"
)


class _Loader(yaml.SafeLoader):
    """SafeLoader that keeps timestamps as strings, so rules convert to JSON losslessly."""


_Loader.yaml_implicit_resolvers = {
    key: [(tag, regexp) for tag, regexp in resolvers if tag != "tag:yaml.org,2002:timestamp"]
    for key, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}


def canonical_bytes(ruleset: dict[str, Any]) -> bytes:
    return (json.dumps(ruleset, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def assemble_ruleset(tarball: bytes, rule_ids: list[str]) -> dict[str, Any]:
    """Collects the rules with the given registry ids from a semgrep-rules tarball.

    A registry id is the rule file's path (dots for slashes, no extension) plus
    the rule's own id, e.g. python/lang/security/audit/eval-detected.yaml ->
    python.lang.security.audit.eval-detected.eval-detected.
    """
    wanted = set(rule_ids)
    found: dict[str, dict[str, Any]] = {}
    with tarfile.open(fileobj=io.BytesIO(tarball), mode="r:gz") as archive:
        for member in archive.getmembers():
            path = PurePosixPath(member.name)
            parts = path.parts[1:]  # drop the "semgrep-rules-<commit>/" root
            if not member.isfile() or not parts or path.suffix not in (".yaml", ".yml"):
                continue
            if any(part.startswith(".") for part in parts) or ".test." in path.name or ".fixed." in path.name:
                continue
            prefix = ".".join([*parts[:-1], PurePosixPath(parts[-1]).stem])
            if not any(rule_id.startswith(prefix + ".") for rule_id in wanted):
                continue
            document = yaml.load(archive.extractfile(member).read().decode("utf-8"), Loader=_Loader)
            for rule in (document or {}).get("rules", []):
                full_id = f"{prefix}.{rule.get('id')}"
                if full_id in wanted:
                    found[full_id] = {**rule, "id": full_id}

    missing = sorted(wanted - set(found))
    if missing:
        raise SystemExit(f"{len(missing)} pinned rule ids are not in the tarball: {', '.join(missing[:10])}")
    return {"rules": [found[rule_id] for rule_id in sorted(found)]}


def download(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as response:  # noqa: S310 (fixed https URLs)
        return response.read()


def pack_rule_ids() -> list[str]:
    pack = yaml.load(download(PACK_URL).decode("utf-8"), Loader=_Loader)
    return sorted(rule["id"] for rule in pack["rules"])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--update", action="store_true", help="re-pin instead of verifying the existing lock")
    parser.add_argument("--commit", help="semgrep-rules commit to pin (with --update)")
    args = parser.parse_args(argv)

    if args.update:
        if not args.commit:
            parser.error("--update needs --commit")
        rule_ids = pack_rule_ids()
        commit = args.commit
    else:
        lock = json.loads(LOCK_FILE.read_text(encoding="utf-8"))
        rule_ids, commit = lock["rule_ids"], lock["source"]["commit"]

    data = canonical_bytes(assemble_ruleset(download(TARBALL_URL.format(commit=commit)), rule_ids))
    digest = sha256(data)

    if args.update:
        lock = {
            "pack": PACK,
            "rule_ids_source": PACK_URL,
            "rule_ids_retrieved": datetime.date.today().isoformat(),
            "source": {"repository": REPOSITORY, "commit": commit},
            "license": LICENSE,
            "rule_count": len(rule_ids),
            "rule_ids": rule_ids,
            "sha256": digest,
        }
        LOCK_FILE.write_text(json.dumps(lock, indent=2) + "\n", encoding="utf-8", newline="\n")
        print(f"Pinned {len(rule_ids)} rules from {REPOSITORY}@{commit}: sha256 {digest}")
    elif digest != lock["sha256"]:
        print(f"Ruleset sha256 {digest} does not match the pin {lock['sha256']}; not written.", file=sys.stderr)
        return 1

    RULESET_FILE.write_bytes(data)
    print(f"Wrote {RULESET_FILE} ({len(rule_ids)} rules, sha256 {digest})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
