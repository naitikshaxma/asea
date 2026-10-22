"""Repository index: symbol extraction, hashing embeddings and the Qdrant index."""

import math

import pytest
from qdrant_client import QdrantClient

from app.pipeline.contract import IndexFile, IndexRequest
from app.rag.embedder import HashingEmbedder, tokens
from app.rag.index import CodeIndex
from app.rag.symbols import extract_symbols
from app.verification.static_analysis import InvalidVerificationInput
from tests.fixture_support import DEMO_APP

SOURCE = '''import x


@bp.get("/items")
@login_required
def list_items():
    return jsonify(service.list_items(g.user["id"]))


class Repo:
    def save(self, item):
        validate(item)
        return db.insert(item)

    def _hidden(self):
        def inner():
            return 1
        return inner()
'''


def demo_files() -> list[IndexFile]:
    return [IndexFile(path=p.relative_to(DEMO_APP).as_posix(), content=p.read_text(encoding="utf-8")) for p in sorted(DEMO_APP.rglob("*.py"))]


@pytest.fixture
def index() -> CodeIndex:
    return CodeIndex(QdrantClient(location=":memory:"))


def test_extract_symbols_finds_functions_classes_and_methods():
    symbols = {s.name: s for s in extract_symbols("app/items.py", SOURCE)}
    assert set(symbols) == {"list_items", "Repo", "Repo.save", "Repo._hidden"}
    route = symbols["list_items"]
    assert (route.kind, route.start_line, route.def_line, route.end_line) == ("function", 4, 6, 7)
    assert route.decorators == ("get", "login_required")
    assert route.is_route and not route.is_test
    assert route.calls == ("jsonify", "list_items")
    assert symbols["Repo.save"].kind == "method"
    assert symbols["Repo.save"].calls == ("insert", "validate")
    assert symbols["Repo"].calls == ()  # classes carry no calls; their methods do
    assert extract_symbols("broken.py", "def (:") == []
    assert all(s.is_test for s in extract_symbols("tests/test_items.py", "def test_x():\n    pass\n"))


def test_tokens_split_identifiers_and_drop_stopwords():
    assert tokens("def getUserName(self): return user_id") == ["getusername", "get", "user", "name", "user_id", "user", "id"]


def test_hashing_embedder_is_deterministic_normalised_and_lexical():
    embedder = HashingEmbedder(dim=64)
    a = embedder.embed("def list_projects(owner_id): return query(owner_id)")
    assert a == HashingEmbedder(dim=64).embed("def list_projects(owner_id): return query(owner_id)")
    assert math.isclose(sum(v * v for v in a), 1.0, rel_tol=1e-9)
    near = embedder.embed("def list_projects_for(owner_id): return query(owner_id)")
    far = embedder.embed("class Renderer: pass  # svg canvas pixels")
    cosine = lambda x, y: sum(p * q for p, q in zip(x, y))  # noqa: E731
    assert cosine(a, near) > cosine(a, far)
    assert math.isclose(sum(v * v for v in embedder.embed("")), 1.0)


def test_index_is_built_once_per_commit_and_then_cached(index):
    first = index.index(IndexRequest(repository_id="repo-a", commit_sha="c1", files=demo_files(), complete=True))
    assert (first.cached, first.complete, first.indexed_files) == (False, True, 11)
    assert first.symbols == 12
    assert index.status("repo-a", "c1").model_dump() == {"repository_id": "repo-a", "commit_sha": "c1", "indexed": True, "symbols": 12}

    again = index.index(IndexRequest(repository_id="repo-a", commit_sha="c1", files=demo_files(), complete=True))
    assert (again.cached, again.indexed_files, again.symbols) == (True, 0, 12)
    assert index.status("repo-a", "c2").indexed is False


def test_a_commit_is_usable_only_after_its_last_batch(index):
    files = demo_files()
    partial = index.index(IndexRequest(repository_id="repo-b", commit_sha="c1", files=files[:5], complete=False))
    assert partial.complete is False
    assert index.status("repo-b", "c1").indexed is False
    done = index.index(IndexRequest(repository_id="repo-b", commit_sha="c1", files=files[5:], complete=True))
    assert done.complete is True
    assert index.status("repo-b", "c1").symbols == 12  # counts both batches


def test_search_is_scoped_to_one_repository_and_commit(index):
    index.index(IndexRequest(repository_id="repo-a", commit_sha="c1", files=demo_files(), complete=True))
    query = '@bp.get("/export")\ndef export_projects():\n    return jsonify(project_service.list_projects(g.user["id"]))'
    hits = index.search("repo-a", "c1", query, 3)
    assert [(h.payload["path"], h.payload["name"]) for h in hits][0] == ("routes/projects.py", "list_projects")
    assert hits[0].payload["decorators"] == ["get", "login_required"]
    assert hits[0].score >= hits[-1].score
    assert index.search("repo-other", "c1", query, 3) == []
    assert index.search("repo-a", "c-other", query, 3) == []


def test_index_ignores_non_python_files_and_rejects_unsafe_paths(index):
    response = index.index(
        IndexRequest(
            repository_id="repo-c",
            commit_sha="c1",
            files=[IndexFile(path="README.md", content="# hi"), IndexFile(path="a.py", content="def f():\n    pass\n")],
            complete=True,
        )
    )
    assert (response.indexed_files, response.symbols) == (1, 1)
    with pytest.raises(InvalidVerificationInput):
        index.index(IndexRequest(repository_id="r", commit_sha="c", files=[IndexFile(path="../etc/x.py", content="")], complete=True))


def test_index_endpoints(client, monkeypatch):
    from app.rag import index as index_module

    monkeypatch.setattr(index_module, "_index", None)
    body = {"repository_id": "repo-e", "commit_sha": "e1", "files": [f.model_dump() for f in demo_files()], "complete": True}
    created = client.post("/api/v1/index", json=body)
    assert created.status_code == 200
    assert created.json()["cached"] is False
    assert client.post("/api/v1/index", json=body).json()["cached"] is True
    assert client.get("/api/v1/index/repo-e/e1").json() == {"repository_id": "repo-e", "commit_sha": "e1", "indexed": True, "symbols": 12}
    bad = client.post("/api/v1/index", json={**body, "commit_sha": "e2", "files": [{"path": "/abs.py", "content": ""}]})
    assert bad.status_code == 422
    assert bad.json()["error"]["code"] == "INVALID_INDEX_INPUT"


def test_index_endpoints_require_the_internal_token(anonymous_client):
    assert anonymous_client.get("/api/v1/index/repo/sha").status_code == 401
    assert anonymous_client.post("/api/v1/index", json={}).status_code == 401
