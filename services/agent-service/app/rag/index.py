"""Repository index in Qdrant: one point per function, method or class.

Points carry repo_id and commit_sha, and every search is filtered by both, so
repositories never see each other's code. A commit is indexed once: when its
last batch arrives a manifest point is written, and later index requests for
the same (repository, commit) return `cached` without re-embedding anything.

The engine stays stateless with respect to the product's data (it never
touches Postgres); this index is derived data that can be rebuilt from git.
Without QDRANT_URL an in-memory Qdrant is used (lost on restart).
"""

import threading
import uuid
import warnings
from dataclasses import dataclass
from typing import Any

from qdrant_client import QdrantClient, models

from app.pipeline.contract import IndexRequest, IndexResponse, IndexStatus
from app.rag.embedder import Embedder, HashingEmbedder
from app.rag.symbols import CodeSymbol, extract_symbols
from app.verification.static_analysis import safe_relative_path

SYMBOLS = "asea_code_symbols"
MANIFESTS = "asea_index_manifests"
UPSERT_BATCH = 256


@dataclass(frozen=True)
class Neighbour:
    payload: dict[str, Any]
    score: float


def _point_id(*parts: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "|".join(parts)))


def _same_commit(repository_id: str, commit_sha: str) -> models.Filter:
    return models.Filter(
        must=[
            models.FieldCondition(key="repo_id", match=models.MatchValue(value=repository_id)),
            models.FieldCondition(key="commit_sha", match=models.MatchValue(value=commit_sha)),
        ]
    )


def symbol_text(path: str, name: str, decorators: list[str] | tuple[str, ...], code: str) -> str:
    return f"{path} {name} {' '.join(decorators)}\n{code}"


class CodeIndex:
    def __init__(self, client: QdrantClient, embedder: Embedder | None = None):
        self.client = client
        self.embedder = embedder or HashingEmbedder()
        self._ensure_collections()

    def _ensure_collections(self) -> None:
        if not self.client.collection_exists(SYMBOLS):
            self.client.create_collection(
                SYMBOLS, vectors_config=models.VectorParams(size=self.embedder.dim, distance=models.Distance.COSINE)
            )
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")  # in-memory Qdrant warns that payload indexes have no effect
                for key in ("repo_id", "commit_sha"):
                    self.client.create_payload_index(SYMBOLS, field_name=key, field_schema=models.PayloadSchemaType.KEYWORD)
        if not self.client.collection_exists(MANIFESTS):
            self.client.create_collection(
                MANIFESTS, vectors_config=models.VectorParams(size=1, distance=models.Distance.DOT)
            )

    def status(self, repository_id: str, commit_sha: str) -> IndexStatus:
        found = self.client.retrieve(MANIFESTS, ids=[_point_id("manifest", repository_id, commit_sha)], with_payload=True)
        symbols = int(found[0].payload.get("symbols", 0)) if found and found[0].payload else 0
        return IndexStatus(repository_id=repository_id, commit_sha=commit_sha, indexed=bool(found), symbols=symbols)

    def index(self, request: IndexRequest) -> IndexResponse:
        status = self.status(request.repository_id, request.commit_sha)
        if status.indexed:
            return IndexResponse(
                repository_id=request.repository_id,
                commit_sha=request.commit_sha,
                indexed_files=0,
                symbols=status.symbols,
                cached=True,
                complete=True,
            )

        points = []
        indexed_files = 0
        for file in request.files:
            path = safe_relative_path(file.path)
            if not path.endswith(".py"):
                continue
            indexed_files += 1
            for symbol in extract_symbols(path, file.content):
                points.append(self._point(request.repository_id, request.commit_sha, symbol))
        for start in range(0, len(points), UPSERT_BATCH):
            self.client.upsert(SYMBOLS, points=points[start : start + UPSERT_BATCH])

        symbols = len(points)
        if request.complete:
            symbols = self.client.count(
                SYMBOLS, count_filter=_same_commit(request.repository_id, request.commit_sha), exact=True
            ).count
            self.client.upsert(
                MANIFESTS,
                points=[
                    models.PointStruct(
                        id=_point_id("manifest", request.repository_id, request.commit_sha),
                        vector=[1.0],
                        payload={
                            "repo_id": request.repository_id,
                            "commit_sha": request.commit_sha,
                            "symbols": symbols,
                            "embedder": self.embedder.name,
                        },
                    )
                ],
            )
        return IndexResponse(
            repository_id=request.repository_id,
            commit_sha=request.commit_sha,
            indexed_files=indexed_files,
            symbols=symbols,
            cached=False,
            complete=request.complete,
        )

    def _point(self, repository_id: str, commit_sha: str, symbol: CodeSymbol) -> models.PointStruct:
        return models.PointStruct(
            id=_point_id(repository_id, commit_sha, symbol.path, symbol.name),
            vector=self.embedder.embed(symbol_text(symbol.path, symbol.name, symbol.decorators, symbol.code)),
            payload={
                "repo_id": repository_id,
                "commit_sha": commit_sha,
                "path": symbol.path,
                "name": symbol.name,
                "kind": symbol.kind,
                "start_line": symbol.start_line,
                "def_line": symbol.def_line,
                "end_line": symbol.end_line,
                "decorators": list(symbol.decorators),
                "calls": list(symbol.calls),
                "is_route": symbol.is_route,
                "is_test": symbol.is_test,
                "code": symbol.code,
            },
        )

    def search(self, repository_id: str, commit_sha: str, text: str, limit: int) -> list[Neighbour]:
        """The symbols of that repository at that commit most similar to `text`."""
        result = self.client.query_points(
            SYMBOLS,
            query=self.embedder.embed(text),
            query_filter=_same_commit(repository_id, commit_sha),
            limit=limit,
            with_payload=True,
        )
        return [Neighbour(payload=dict(p.payload or {}), score=float(p.score)) for p in result.points]


_index: CodeIndex | None = None
_lock = threading.Lock()


def get_index(qdrant_url: str | None, qdrant_api_key: str | None) -> CodeIndex:
    """The process-wide index (Qdrant at QDRANT_URL, or in memory)."""
    global _index
    with _lock:
        if _index is None:
            client = (
                QdrantClient(url=qdrant_url, api_key=qdrant_api_key or None, timeout=10)
                if qdrant_url
                else QdrantClient(location=":memory:")
            )
            _index = CodeIndex(client)
        return _index


def reset_index() -> None:
    """Drops the process-wide index (tests)."""
    global _index
    with _lock:
        _index = None
