"""Which head-side lines a unified diff changes, per file."""

from dataclasses import dataclass, field

from unidiff import PatchSet
from unidiff.errors import UnidiffParseError


class InvalidDiffError(ValueError):
    pass


@dataclass
class FileChanges:
    # Head line numbers the diff adds
    added: set[int] = field(default_factory=set)
    # Added lines plus, for every removal, the head line where it happened (so
    # deleting a decorator still marks the function it belonged to)
    touched: set[int] = field(default_factory=set)
    # Text of removed lines (to tell a modified definition from a new one)
    removed_text: list[str] = field(default_factory=list)


def changed_lines(unified_diff: str) -> dict[str, FileChanges]:
    """Maps each file the diff adds or modifies (head path) to its changes.
    Deleted files are omitted."""
    try:
        patch = PatchSet(unified_diff)
    except UnidiffParseError as exc:
        raise InvalidDiffError(f"unified_diff could not be parsed: {exc}") from exc

    result: dict[str, FileChanges] = {}
    for patched in patch:
        if patched.is_removed_file:
            continue
        changes = FileChanges()
        for hunk in patched:
            removal_pending = False
            last_head_line = hunk.target_start - 1
            for line in hunk:
                if line.is_removed:
                    removal_pending = True
                    changes.removed_text.append(line.value)
                    continue
                if not (line.is_added or line.is_context):
                    continue  # "\ No newline at end of file"
                if line.is_added:
                    changes.added.add(line.target_line_no)
                    changes.touched.add(line.target_line_no)
                elif removal_pending:
                    changes.touched.add(line.target_line_no)
                removal_pending = False
                last_head_line = line.target_line_no
            if removal_pending and last_head_line >= 1:
                changes.touched.add(last_head_line)
        result[patched.path] = changes
    return result
