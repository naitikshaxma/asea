"""Functions, methods and classes of a Python file, with the facts the agents use.

The unit of the repository index (one point per symbol) and of the change
context (which symbols a diff touches). Nested functions belong to their
enclosing symbol.
"""

import ast
from dataclasses import dataclass
from typing import Literal

from app.verification.ast_checks import is_route_decorator, is_test_file, name_of

MAX_SYMBOL_CODE_CHARS = 4000


@dataclass(frozen=True)
class CodeSymbol:
    path: str
    # Qualified name: `func`, `Class` or `Class.method`
    name: str
    kind: Literal["function", "method", "class"]
    # First line including decorators, the def/class line, and the last line
    start_line: int
    def_line: int
    end_line: int
    decorators: tuple[str, ...]
    # Names of everything called in the body (sorted, unique)
    calls: tuple[str, ...]
    is_route: bool
    is_test: bool
    code: str

    def contains(self, line: int) -> bool:
        return self.start_line <= line <= self.end_line


def _calls(node: ast.AST) -> tuple[str, ...]:
    # The body only: decorator calls such as @bp.get("/") are not calls the function makes
    body = getattr(node, "body", [])
    names = {name_of(n.func) for stmt in body for n in ast.walk(stmt) if isinstance(n, ast.Call)}
    return tuple(sorted(n for n in names if n))


def _symbol(path: str, lines: list[str], node: ast.AST, name: str, kind: str, test: bool) -> CodeSymbol:
    decorators = getattr(node, "decorator_list", [])
    start = min([node.lineno, *(d.lineno for d in decorators)])
    end = getattr(node, "end_lineno", None) or node.lineno
    code = "\n".join(lines[start - 1 : end])[:MAX_SYMBOL_CODE_CHARS]
    return CodeSymbol(
        path=path,
        name=name,
        kind=kind,  # type: ignore[arg-type]
        start_line=start,
        def_line=node.lineno,
        end_line=end,
        decorators=tuple(n for n in (name_of(d) for d in decorators) if n),
        calls=_calls(node) if kind != "class" else (),
        is_route=any(is_route_decorator(d) for d in decorators),
        is_test=test,
        code=code,
    )


def extract_symbols(path: str, source: str) -> list[CodeSymbol]:
    """Top-level functions and classes and their methods; [] if the file does not parse."""
    try:
        tree = ast.parse(source, filename=path)
    except (SyntaxError, ValueError):
        return []
    lines = source.splitlines()
    test = is_test_file(path)
    symbols: list[CodeSymbol] = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            symbols.append(_symbol(path, lines, node, node.name, "function", test))
        elif isinstance(node, ast.ClassDef):
            symbols.append(_symbol(path, lines, node, node.name, "class", test))
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    symbols.append(_symbol(path, lines, item, f"{node.name}.{item.name}", "method", test))
    return symbols
