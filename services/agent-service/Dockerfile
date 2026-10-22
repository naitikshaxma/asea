# Verification engine (stateless FastAPI service). Build context: repository root.
#   docker build -f services/agent-service/Dockerfile .
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY services/agent-service/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY services/agent-service/app app
COPY services/agent-service/rules rules
COPY services/agent-service/scripts scripts
USER nobody
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
