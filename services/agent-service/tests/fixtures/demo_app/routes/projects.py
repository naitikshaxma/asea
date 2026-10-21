from flask import Blueprint, g, jsonify, request

from demo_app.auth import login_required
from demo_app.services import projects as project_service
from demo_app.validation import validate_payload

bp = Blueprint("projects", __name__, url_prefix="/projects")


@bp.get("/")
@login_required
def list_projects():
    return jsonify(project_service.list_projects(g.user["id"]))


@bp.post("/")
@login_required
def create_project():
    payload = validate_payload(request.get_json(), required=["name"])
    project = project_service.create_project(g.user["id"], payload["name"])
    return jsonify(project), 201
