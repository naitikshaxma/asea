# Security Architecture and Threat Model

## 1. Security Philosophy

The Autonomous AI Software Engineering Platform is designed on **zero-trust principles**:
1. **Never trust generated code**: Any code produced or modified by an AI model is treated as untrusted, potentially malicious input.
2. **Never execute untrusted code on the host**: Host shell execution is disabled by design.
3. **No credentials in frontend or workers**: The client interface and worker containers have zero access to database credentials or internal infrastructure keys.
4. **Defense in Depth**: Isolation is enforced across network, kernel, filesystem, and identity boundaries.

---

## 2. Threat Modeling

### Threat 1: Malicious Code Execution (RCE) via Prompt Injection or Repo Analysis
- **Scenario**: An attacker injects malicious commands into a repository issue, commit message, or code file (e.g. `rm -rf /`, exfiltration scripts).
- **Mitigation**:
  - Phase 1: Arbitrary shell execution is disabled entirely.
  - Phase 2: All execution occurs inside disposable gVisor/Firecracker micro-sandboxes.
  - Sandbox limits: `ALL` capabilities dropped, `no-new-privileges` flag set, unprivileged `UID 10001`, read-only root filesystem.

### Threat 2: Secret & Credential Exfiltration
- **Scenario**: Generated code or compromised agent attempts to dump environment variables or steal cloud credentials.
- **Mitigation**:
  - Sandboxes never receive database passwords, JWT secrets, or cloud API keys.
  - Metadata IP (`169.254.169.254`) blocked by iptables firewall rule in the sandbox network namespace.
  - Logger masks sensitive keys (`password`, `token`, `secret`, `authorization`, `cookie`, `key`) before outputting JSON log entries.
  - `.gitignore` explicitly blocks `.env`, `.env.*`, and private keys from Git history.

### Threat 3: Denial of Service via Resource Exhaustion
- **Scenario**: Malicious patch or test suite generates an infinite loop, memory leak, or fork bomb.
- **Mitigation**:
  - Linux Cgroups v2 enforce strict limits:
    - Maximum 2 vCPUs.
    - Maximum 2 GB RAM (OOM killed on breach).
    - Maximum 100 PIDs (fork bombs immediately blocked).
  - Hard wall-clock timeout (e.g. 120 seconds) kills container unconditionally.

### Threat 4: Unauthorized Access to Internal Services
- **Scenario**: Worker container attempts to connect to local PostgreSQL or Redis instance.
- **Mitigation**:
  - Worker network namespace is isolated from the host Docker bridge network.
  - Default network egress policy is `DROP`.
  - Only whitelisted public package registries (npm, PyPI) are reachable via an inspected egress proxy.

---

## 3. Configuration & Secrets Management

- **Local Development**: Safe placeholders are defined in `.env.example`.
- **Environment Validation**: Zod schema in `services/api/src/config.ts` and Pydantic BaseSettings in `services/agent-service/app/config.py` validate all configurations on process boot. Missing or malformed variables halt the process immediately.
- **Log Sanitation**: Full database connection strings (e.g. `postgresql://user:pass@host/db`) have their password segments dynamically masked (`postgresql://user:***@host/db`) before logging.
