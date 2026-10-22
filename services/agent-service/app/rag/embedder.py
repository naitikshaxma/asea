"""Embeddings for code symbols.

HashingEmbedder is a deterministic, offline embedding: identifiers are split
into word parts (snake_case and camelCase), each part is hashed into one of
`dim` buckets with a sign, counts are damped (1 + log tf) and the vector is L2
normalised. Cosine similarity then measures shared vocabulary, which is what
"code like this" means for the architecture agent's neighbour lookup. It is
lexical, not semantic: renamed concepts are not matched.
"""

import hashlib
import math
import re
from collections import Counter
from typing import Protocol

_IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_CAMEL = re.compile(r"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|[0-9]+")
_STOPWORDS = {
    "and", "as", "def", "elif", "else", "false", "for", "from", "if", "import", "in", "is",
    "none", "not", "or", "pass", "return", "self", "true", "with", "class", "the", "a",
}


class Embedder(Protocol):
    name: str
    dim: int

    def embed(self, text: str) -> list[float]: ...


def tokens(text: str) -> list[str]:
    out: list[str] = []
    for identifier in _IDENTIFIER.findall(text):
        parts = [p.lower() for chunk in identifier.split("_") for p in _CAMEL.findall(chunk)]
        whole = identifier.lower()
        if whole not in _STOPWORDS:
            out.append(whole)
        if len(parts) > 1:
            out.extend(p for p in parts if p not in _STOPWORDS and len(p) > 1)
    return out


class HashingEmbedder:
    name = "hashing-v1"

    def __init__(self, dim: int = 256):
        self.dim = dim

    def embed(self, text: str) -> list[float]:
        vector = [0.0] * self.dim
        for token, count in Counter(tokens(text)).items():
            digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
            bucket = int.from_bytes(digest[:4], "big") % self.dim
            sign = 1.0 if digest[4] & 1 else -1.0
            vector[bucket] += sign * (1.0 + math.log(count))
        norm = math.sqrt(sum(v * v for v in vector))
        if norm == 0:
            vector[0] = 1.0  # empty text still gets a valid (unit) vector
            return vector
        return [v / norm for v in vector]
