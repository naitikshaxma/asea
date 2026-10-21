# Local Development Guide

## 1. Prerequisites

Ensure the following tools are installed:
- **Node.js**: `v24.x` or later (tested on `v24.12.0`)
- **npm**: `v11.x` or later (tested on `11.7.0`)
- **Python**: `3.12.x` or later
- **Docker & Docker Compose**: `v28.x` or later (Docker Desktop / engine)
- **Git**: `2.x` or later

---

## 2. Quickstart

### Step 1: Clone and Configure Environment
```bash
# Copy example environment variables
cp .env.example .env
```

Review the values in `.env`. The defaults are safe for local development out-of-the-box.

### Step 2: Install Node Monorepo Dependencies
```bash
npm install
```
This installs dependencies across `packages/contracts`, `services/api`, and `apps/web`.

### Step 3: Setup Python Virtual Environment (Agent Service)
```bash
# From workspace root:
cd services/agent-service

# Create virtual environment
python -m venv .venv

# Activate virtual environment
# Windows (PowerShell):
.venv\Scripts\Activate.ps1
# Windows (CMD):
.venv\Scripts\activate.bat
# Linux/macOS:
source .venv/bin/activate

# Install Python dependencies
pip install -r requirements.txt

# Return to monorepo root
cd ../..
```

---

## 3. Starting Services

### Option A: Local Dev Infrastructure (PostgreSQL & Redis)
To spin up development containers:
```bash
# Start PostgreSQL (port 5432) and Redis (port 6379)
npm run docker:up

# Check container status
docker compose ps

# View logs
npm run docker:logs

# Stop containers
npm run docker:down
```

### Option B: Start Node API and Web Dashboard
```bash
npm run dev
```
- API will start on: `http://localhost:4000`
- Web Dashboard will start on: `http://localhost:5173`

### Option C: Start Python Agent Service
```bash
# Ensure your Python virtual environment is activated:
npm run dev:agent
# Runs on: http://localhost:8000
```

---

## 4. Running Checks and Tests

### Run All Tests
```bash
# Run TypeScript tests (API + Web)
npm test

# Run Python Pytest tests
npm run test:python

# Run All (TypeScript + Python)
npm run test:all
```

### Type Checking & Linting
```bash
# Type check all workspaces
npm run typecheck

# Alias for linting
npm run lint
```

### Build Production Bundles
```bash
npm run build
```

---

## 5. Service URLs and Health Endpoints

| Service | Local URL | Health Endpoint | Readiness Endpoint |
|---|---|---|---|
| **Web Dashboard** | `http://localhost:5173` | — | — |
| **Express API** | `http://localhost:4000` | `http://localhost:4000/health` | `http://localhost:4000/ready` |
| **Agent Service** | `http://localhost:8000` | `http://localhost:8000/health` | `http://localhost:8000/ready` |
| **PostgreSQL** | `127.0.0.1:5432` | Container healthcheck (`pg_isready`) | Tested via API `/ready` |
| **Redis** | `127.0.0.1:6379` | Container healthcheck (`redis-cli ping`) | Tested via API `/ready` |

---

## 6. Troubleshooting

### Port 5432 or 6379 Already in Use
If another Postgres or Redis instance is running locally, modify the ports in `.env`:
```env
POSTGRES_PORT=5433
REDIS_PORT=6380
```
Then restart Docker Compose: `npm run docker:up`.

### API Reports `not_ready`
- Check whether Docker containers are running: `docker compose ps`.
- Check if `POSTGRES_REQUIRED_FOR_READINESS` is set to `true` in your `.env`. In dev mode, set it to `false` if you want the API to remain in degraded mode when containers are stopped.

### Python ModuleNotFoundError
Ensure you have activated the virtual environment before running pytest:
```bash
cd services/agent-service
.venv\Scripts\activate
pytest
```
