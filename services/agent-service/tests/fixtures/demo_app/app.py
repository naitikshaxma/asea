from flask import Flask

from demo_app.routes.projects import bp as projects_bp


def create_app():
    app = Flask(__name__)
    app.register_blueprint(projects_bp)
    return app
