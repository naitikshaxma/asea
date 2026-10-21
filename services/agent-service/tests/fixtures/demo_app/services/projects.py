from demo_app.db import get_connection


def list_projects(owner_id):
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, name FROM projects WHERE owner_id = ?", (owner_id,))
        return [{"id": row[0], "name": row[1]} for row in cursor.fetchall()]


def create_project(owner_id, name):
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO projects (owner_id, name) VALUES (?, ?)",
            (owner_id, name),
        )
        return {"id": cursor.lastrowid, "name": name}
