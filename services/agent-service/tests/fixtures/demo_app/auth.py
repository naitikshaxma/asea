from functools import wraps

from flask import abort, g


def login_required(view):
    """Rejects the request with 401 unless a user is attached to the request."""

    @wraps(view)
    def wrapped(*args, **kwargs):
        if g.get("user") is None:
            abort(401)
        return view(*args, **kwargs)

    return wrapped
