# Pinned Semgrep ruleset

The static-analysis node runs Semgrep with a fixed, offline ruleset: the
151 rules of the Semgrep registry pack `p/python`, taken from the
[semgrep-rules](https://github.com/semgrep/semgrep-rules) repository at a
pinned commit.

| | |
|---|---|
| Rule ids | the `p/python` pack as listed by https://semgrep.dev/c/p/python on 2026-10-22 (151 rules) |
| Rule content | `semgrep/semgrep-rules` at commit `17e31e11ebac99fb7dfe1cd288f7a32151b6f3f9` (2026-10-15) |
| Assembled ruleset sha256 | `c7b52239713bc417fcc014296a821a6dccbcef6bac408a7e4bb17259e2607b0b` |
| License | [Semgrep Rules License v1.0](https://semgrep.dev/legal/rules-license): internal business use only; no redistribution, and not to be made available to others as a service |

## Why the rules are not in this repository

The Semgrep Rules License does not allow redistributing the rules, so only
`p-python.lock.json` (commit, rule ids, sha256) is committed. Each developer
or deployment downloads the rules itself:

```bash
npm run semgrep:rules     # from the repo root
```

`scripts/fetch_semgrep_rules.py` downloads the semgrep-rules tarball at the
pinned commit, picks the pinned rule ids (renamed to their registry ids, e.g.
`python.lang.security.audit.eval-detected.eval-detected`), writes them as
canonical JSON to `p-python.json` (gitignored) and fails if its sha256
differs from the lock. The file is only ever written with that exact content.

## Runtime

The agent service never fetches rules: it reads `p-python.json`, checks its
sha256 against the lock, copies it into the scan directory and runs `semgrep
scan --config <that file>`. If the file is missing or its hash differs,
Semgrep is skipped and reported in `tools_unavailable`. When Semgrep runs, the
ruleset's sha256 is returned as `semgrep_ruleset_sha256` and recorded in the
verification run's audit chain.

## Updating the pin

```bash
cd services/agent-service
.venv/Scripts/python scripts/fetch_semgrep_rules.py --update --commit <semgrep-rules commit>
```

This re-reads the pack's rule ids from the registry, assembles the ruleset at
the given commit and rewrites the lock (commit, ids, date, sha256). Update the
table above in the same commit.

Using these rules in ASEA offered to third parties, or publishing a repository
that contains `p-python.json`, would conflict with the license.
