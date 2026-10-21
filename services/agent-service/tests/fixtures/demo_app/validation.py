class ValidationError(ValueError):
    pass


def validate_payload(payload, required):
    """Checks that payload is a JSON object containing every required field."""
    if not isinstance(payload, dict):
        raise ValidationError("payload must be a JSON object")
    missing = [field for field in required if field not in payload]
    if missing:
        raise ValidationError("missing fields: " + ", ".join(missing))
    return payload
