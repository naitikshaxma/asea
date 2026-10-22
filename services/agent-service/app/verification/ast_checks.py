"""Deterministic Python ast checks, limited to the lines a diff changes.

Every check reports at most one finding per node, at the node's first line.
See the "Static analysis" section of the agent-service README for the rules.
"""

import ast
import hashlib
import re
from dataclasses import dataclass
from pathlib import PurePosixPath

from app.verification.contract import Finding
from app.verification.diff_ranges import FileChanges


@dataclass(frozen=True)
class Rule:
    rule_id: str
    category: str
    severity: str
    title: str
    remediation: str


ROUTE_NO_AUTH = Rule(
    "ASEA-PY-ROUTE-NO-AUTH",
    "static",
    "high",
    "Route handler has no authentication decorator",
    "Add the project's authentication decorator (e.g. @login_required), or document why the route is public.",
)
BARE_EXCEPT = Rule(
    "ASEA-PY-BARE-EXCEPT",
    "static",
    "low",
    "Bare except clause",
    "Catch specific exception types; a bare except also swallows KeyboardInterrupt and SystemExit.",
)
HARDCODED_SECRET = Rule(
    "ASEA-PY-HARDCODED-SECRET",
    "static",
    "critical",
    "Hardcoded secret-like value",
    "Load the value from configuration or a secrets manager, and rotate it if it was ever real.",
)
SUBPROCESS_SHELL = Rule(
    "ASEA-PY-SUBPROCESS-SHELL",
    "static",
    "high",
    "subprocess call with shell=True",
    "Pass the command as an argument list and drop shell=True.",
)
EVAL_EXEC = Rule(
    "ASEA-PY-EVAL-EXEC",
    "static",
    "high",
    "Use of eval() or exec()",
    "Avoid evaluating dynamic code; parse the input explicitly (e.g. ast.literal_eval or json).",
)
SQL_STRING_FORMAT = Rule(
    "ASEA-PY-SQL-STRING-FORMAT",
    "static",
    "high",
    "String-formatted SQL passed to execute()",
    "Use a parameterised query: pass the values as execute()'s second argument.",
)
TEST_GAP = Rule(
    "ASEA-PY-TEST-GAP",
    "test_gap",
    "medium",
    "New public function is not referenced by any test",
    "Add a test that exercises the new function.",
)
PARSE_ERROR = Rule(
    "ASEA-PY-PARSE-ERROR",
    "static",
    "medium",
    "Changed Python file could not be parsed",
    "Fix the syntax error; no other ast checks ran on this file.",
)

ROUTE_DECORATOR_ATTRS = {"route", "get", "post", "put", "patch", "delete"}
SECRET_NAME = re.compile(r"secret|token|passw(or)?d|api_?key|private_?key|access_?key|credential", re.IGNORECASE)
SUBPROCESS_FUNCS = {"run", "call", "check_call", "check_output", "Popen"}
SQL_EXECUTE_ATTRS = {"execute", "executemany"}
MIN_SECRET_LENGTH = 8


def finding_id(rule_id: str, file: str, line: int) -> str:
    return hashlib.sha256(f"{rule_id}|{file}|{line}".encode()).hexdigest()[:16]


def make_finding(rule: Rule, file: str, line: int, evidence: list[str]) -> Finding:
    return Finding(
        id=finding_id(rule.rule_id, file, line),
        category=rule.category,
        severity=rule.severity,
        title=rule.title,
        file=file,
        line=line,
        evidence=evidence,
        source="deterministic",
        rule_id=rule.rule_id,
        remediation=rule.remediation,
    )


def is_test_file(path: str) -> bool:
    p = PurePosixPath(path)
    return (
        "tests" in p.parts[:-1]
        or "test" in p.parts[:-1]
        or p.name.startswith("test_")
        or p.name.endswith("_test.py")
        or p.name == "conftest.py"
    )


def name_of(node: ast.expr) -> str | None:
    """Decorator or callee name: `x` for x, a.x and x(...)."""
    if isinstance(node, ast.Call):
        return name_of(node.func)
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def is_route_decorator(node: ast.expr) -> bool:
    return isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in ROUTE_DECORATOR_ATTRS


def _is_formatted_string(node: ast.expr) -> bool:
    if isinstance(node, ast.JoinedStr):
        return any(isinstance(v, ast.FormattedValue) for v in node.values)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mod):
        return _is_str(node.left)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        parts = [node.left, node.right]
        return any(_is_str(p) or _is_formatted_string(p) for p in parts) and not all(_is_str(p) for p in parts)
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "format":
        return _is_str(node.func.value)
    return False


def _is_str(node: ast.expr) -> bool:
    return isinstance(node, ast.Constant) and isinstance(node.value, str)


class _Checker:
    def __init__(self, path: str, source: str, changes: FileChanges, test_sources: list[str], auth_decorators: set[str]):
        self.path = path
        self.source = source
        self.lines = source.splitlines()
        self.changes = changes
        self.test_sources = test_sources
        self.auth_decorators = auth_decorators
        self.findings: list[Finding] = []
        self.subprocess_names: set[str] = set()

    def report(self, rule: Rule, line: int, evidence: list[str] | None = None) -> None:
        self.findings.append(make_finding(rule, self.path, line, evidence or [self.line_text(line)]))

    def line_text(self, line: int) -> str:
        return self.lines[line - 1].strip() if 0 < line <= len(self.lines) else ""

    def touches(self, node: ast.AST) -> bool:
        end = getattr(node, "end_lineno", None) or node.lineno
        return any(n in self.changes.touched for n in range(node.lineno, end + 1))

    def run(self, tree: ast.Module) -> list[Finding]:
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module == "subprocess":
                self.subprocess_names.update(a.asname or a.name for a in node.names if a.name in SUBPROCESS_FUNCS)
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                self.check_route(node)
            elif isinstance(node, ast.ExceptHandler):
                if node.type is None and node.lineno in self.changes.touched:
                    self.report(BARE_EXCEPT, node.lineno)
            elif isinstance(node, (ast.Assign, ast.AnnAssign)):
                self.check_secret(node)
            elif isinstance(node, ast.Call) and self.touches(node):
                self.check_call(node)
        self.check_test_gaps(tree)
        return self.findings

    def check_route(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        if not any(is_route_decorator(d) for d in node.decorator_list):
            return
        header = {node.lineno} | {d.lineno for d in node.decorator_list}
        if not header & self.changes.touched:
            return
        if not any(name_of(d) in self.auth_decorators for d in node.decorator_list):
            route = next(d for d in node.decorator_list if is_route_decorator(d))
            self.report(ROUTE_NO_AUTH, node.lineno, [self.line_text(route.lineno), self.line_text(node.lineno)])

    def check_secret(self, node: ast.Assign | ast.AnnAssign) -> None:
        value = node.value
        if value is None or not _is_str(value) or not self.touches(node):
            return
        text = value.value
        if len(text) < MIN_SECRET_LENGTH or text.startswith(("http://", "https://")):
            return
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        for target in targets:
            name = name_of(target)
            if name and SECRET_NAME.search(name):
                # Never echo the value itself
                self.report(HARDCODED_SECRET, node.lineno, [f"{name} = <redacted string, {len(text)} characters>"])
                return

    def check_call(self, node: ast.Call) -> None:
        func = node.func
        if isinstance(func, ast.Name) and func.id in {"eval", "exec"}:
            self.report(EVAL_EXEC, node.lineno)
        is_subprocess = (
            isinstance(func, ast.Attribute)
            and func.attr in SUBPROCESS_FUNCS
            and isinstance(func.value, ast.Name)
            and func.value.id == "subprocess"
        ) or (isinstance(func, ast.Name) and func.id in self.subprocess_names)
        if is_subprocess and any(
            k.arg == "shell" and isinstance(k.value, ast.Constant) and k.value.value is True for k in node.keywords
        ):
            self.report(SUBPROCESS_SHELL, node.lineno)
        if (
            isinstance(func, ast.Attribute)
            and func.attr in SQL_EXECUTE_ATTRS
            and node.args
            and _is_formatted_string(node.args[0])
        ):
            self.report(SQL_STRING_FORMAT, node.lineno, [self.line_text(node.args[0].lineno)])

    def check_test_gaps(self, tree: ast.Module) -> None:
        if is_test_file(self.path):
            return
        candidates = [n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
        for cls in (n for n in tree.body if isinstance(n, ast.ClassDef)):
            candidates += [n for n in cls.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
        for fn in candidates:
            if fn.name.startswith("_") or fn.lineno not in self.changes.added:
                continue
            if any(is_route_decorator(d) for d in fn.decorator_list):
                continue  # tests reach route handlers through their URL, not their name
            definition = re.compile(rf"\bdef\s+{re.escape(fn.name)}\b")
            if any(definition.search(text) for text in self.changes.removed_text):
                continue  # an existing function whose definition line changed
            reference = re.compile(rf"\b{re.escape(fn.name)}\b")
            if not any(reference.search(src) for src in self.test_sources):
                self.report(TEST_GAP, fn.lineno)


def run_ast_checks(
    path: str,
    source: str,
    changes: FileChanges,
    test_sources: list[str],
    auth_decorators: set[str],
) -> list[Finding]:
    try:
        tree = ast.parse(source, filename=path)
    except SyntaxError as exc:
        line = exc.lineno if exc.lineno and exc.lineno >= 1 else 1
        return [make_finding(PARSE_ERROR, path, line, [f"SyntaxError: {exc.msg}"])]
    return _Checker(path, source, changes, test_sources, auth_decorators).run(tree)
