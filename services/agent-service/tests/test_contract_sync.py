"""Keeps the Pydantic contract in sync with the Zod contract.

packages/contracts/schemas/asea-contract.schema.json is generated from the Zod
schemas (pinned by services/api/tests/aseaContract.test.ts). Both JSON Schemas
are reduced to the parts that define the wire shape (types, enums, required
fields, nesting and value constraints) and compared.
"""

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from app.verification.contract import (
    ChangedFile,
    Finding,
    StaticAnalysisResult,
    VerificationRequest,
)
from app.verification.policy import PolicyConfig, ScoreRequest, ScoreResult

ZOD_SCHEMA_FILE = (
    Path(__file__).resolve().parents[3] / "packages" / "contracts" / "schemas" / "asea-contract.schema.json"
)

MODELS = {
    "ChangedFile": ChangedFile,
    "VerificationRequest": VerificationRequest,
    "Finding": Finding,
    "StaticAnalysisResult": StaticAnalysisResult,
    "PolicyConfig": PolicyConfig,
    "ScoreRequest": ScoreRequest,
    "ScoreResult": ScoreResult,
}

CONSTRAINT_KEYWORDS = (
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "pattern",
)


def normalize(schema: dict[str, Any], defs: dict[str, Any] | None = None) -> dict[str, Any]:
    if defs is None:
        defs = schema.get("$defs") or schema.get("definitions") or {}

    if "$ref" in schema:
        name = schema["$ref"].rsplit("/", 1)[-1]
        return normalize(defs[name], defs)

    if "anyOf" in schema:
        variants = [normalize(v, defs) for v in schema["anyOf"]]
        merged_types = sorted({t for v in variants for t in v.get("type", [])})
        base = next((v for v in variants if v.get("type") != ["null"]), {})
        return {**base, "type": merged_types}

    out: dict[str, Any] = {}
    if "type" in schema:
        types = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        out["type"] = sorted(types)
    if "const" in schema:
        out["enum"] = [schema["const"]]
    if "enum" in schema:
        out["enum"] = sorted(schema["enum"])
    if "enum" in out and "type" not in out:
        out["type"] = ["string"]
    if "properties" in schema:
        out["properties"] = {k: normalize(v, defs) for k, v in schema["properties"].items()}
        out["required"] = sorted(schema.get("required", []))
    if "items" in schema:
        out["items"] = normalize(schema["items"], defs)
    for keyword in CONSTRAINT_KEYWORDS:
        if keyword in schema:
            out[keyword] = schema[keyword]
    return out


@pytest.fixture(scope="module")
def zod_schemas() -> dict[str, Any]:
    return json.loads(ZOD_SCHEMA_FILE.read_text(encoding="utf-8"))


@pytest.mark.parametrize("name", MODELS)
def test_pydantic_model_matches_zod_schema(name: str, zod_schemas: dict[str, Any]) -> None:
    assert name in zod_schemas, f"{name} missing from {ZOD_SCHEMA_FILE.name}; regenerate it from Zod"
    assert normalize(MODELS[name].model_json_schema()) == normalize(zod_schemas[name])


def test_every_zod_schema_has_a_pydantic_model(zod_schemas: dict[str, Any]) -> None:
    assert set(zod_schemas) == set(MODELS)


def test_comparison_detects_drift(zod_schemas: dict[str, Any]) -> None:
    drifted = copy.deepcopy(zod_schemas["Finding"])
    drifted["properties"]["severity"]["enum"].append("info")
    assert normalize(Finding.model_json_schema()) != normalize(drifted)

    renamed = copy.deepcopy(zod_schemas["VerificationRequest"])
    renamed["properties"]["head"] = renamed["properties"].pop("head_sha")
    assert normalize(VerificationRequest.model_json_schema()) != normalize(renamed)
