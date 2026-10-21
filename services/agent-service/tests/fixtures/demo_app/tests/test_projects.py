import sqlite3

import pytest

from demo_app.services import projects as project_service


@pytest.fixture
def db(tmp_path, monkeypatch):
    path = tmp_path / "demo.db"
    monkeypatch.setenv("DEMO_DB_PATH", str(path))
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE projects (id INTEGER PRIMARY KEY, owner_id INTEGER, name TEXT)")
    return path


def test_create_project_returns_new_row(db):
    project = project_service.create_project(1, "Apollo")
    assert project == {"id": 1, "name": "Apollo"}


def test_list_projects_filters_by_owner(db):
    project_service.create_project(1, "Apollo")
    project_service.create_project(2, "Gemini")
    assert project_service.list_projects(1) == [{"id": 1, "name": "Apollo"}]
