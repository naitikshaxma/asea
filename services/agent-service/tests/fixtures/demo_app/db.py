import os
import sqlite3


def get_connection():
    return sqlite3.connect(os.environ.get("DEMO_DB_PATH", "demo.db"))
