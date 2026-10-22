"""The ingest node: a parsed view of the change that every agent reads.

Built only from the request (diff + head content of the changed files), like
the static-analysis node. Facts are Python-only, matching the static checks.
"""

import re
from dataclasses import dataclass, field

from app.rag.symbols import CodeSymbol, extract_symbols
from app.verification.ast_checks import is_test_file
from app.verification.contract import VerificationRequest
from app.verification.diff_ranges import FileChanges, InvalidDiffError, changed_lines
from app.verification.static_analysis import InvalidVerificationInput, safe_relative_path


@dataclass(frozen=True)
class AddedLine:
    path: str
    line: int
    text: str


@dataclass
class ChangeContext:
    request: VerificationRequest
    files: dict[str, str]
    changes: dict[str, FileChanges]
    added_lines: list[AddedLine]
    # Python symbols (functions, methods, classes) with a touched line
    changed_symbols: list[CodeSymbol]
    test_files: list[str]
    test_sources: list[str] = field(default_factory=list)

    def symbol_named(self, path: str, name: str) -> CodeSymbol | None:
        return next((s for s in self.changed_symbols if s.path == path and s.name == name), None)

    def new_public_functions(self) -> list[CodeSymbol]:
        """New (not merely edited) public functions and methods outside tests and route handlers."""
        out = []
        for symbol in self.changed_symbols:
            if symbol.kind == "class" or symbol.is_test or symbol.is_route:
                continue
            short = symbol.name.rsplit(".", 1)[-1]
            if short.startswith("_") or symbol.def_line not in self.changes[symbol.path].added:
                continue
            definition = re.compile(rf"\bdef\s+{re.escape(short)}\b")
            if any(definition.search(text) for text in self.changes[symbol.path].removed_text):
                continue
            out.append(symbol)
        return out

    def referenced_by_tests(self, symbol: CodeSymbol) -> bool:
        short = re.escape(symbol.name.rsplit(".", 1)[-1])
        return any(re.search(rf"\b{short}\b", src) for src in self.test_sources)

    def first_location(self) -> tuple[str, int]:
        """Fallback location for a finding about the change as a whole."""
        if self.added_lines:
            return self.added_lines[0].path, self.added_lines[0].line
        for path, changes in sorted(self.changes.items()):
            if changes.touched and path in self.files:
                return path, min(changes.touched)
        path = next(iter(sorted(self.files)), "")
        return path, 1


def build_change_context(request: VerificationRequest) -> ChangeContext:
    try:
        changes = {safe_relative_path(p): c for p, c in changed_lines(request.unified_diff).items()}
    except InvalidDiffError as exc:
        raise InvalidVerificationInput(str(exc)) from exc
    files = {safe_relative_path(f.path): f.head_content for f in request.changed_files}

    added: list[AddedLine] = []
    symbols: list[CodeSymbol] = []
    for path in sorted(changes):
        content = files.get(path)
        if content is None:
            continue
        lines = content.splitlines()
        added += [AddedLine(path, n, lines[n - 1]) for n in sorted(changes[path].added) if 0 < n <= len(lines)]
        if path.endswith(".py"):
            touched = changes[path].touched
            for symbol in extract_symbols(path, content):
                body = range(symbol.start_line, symbol.end_line + 1)
                if symbol.kind == "class":
                    # The class itself only when its header changed; methods are separate symbols
                    if not {symbol.start_line, symbol.def_line} & touched:
                        continue
                elif not any(n in touched for n in body):
                    continue
                symbols.append(symbol)

    tests = sorted(p for p in files if is_test_file(p))
    return ChangeContext(
        request=request,
        files=files,
        changes=changes,
        added_lines=added,
        changed_symbols=symbols,
        test_files=[p for p in tests if p in changes],
        test_sources=[files[p] for p in tests],
    )
