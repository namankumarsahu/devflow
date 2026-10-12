# DevFlow — self-hosted deployment platform

Connect a GitHub repo, deploy with one click, watch the build live over WebSockets, and roll back instantly.

**Stack:** Node.js · Express 5 · TypeScript · PostgreSQL · Prisma · Redis · BullMQ · React · Tailwind · Docker Compose · GitHub Actions · Jest + Supertest

## Features
- JWT auth with `USER` / `ADMIN` roles (first registered account is admin)
- Projects: GitHub repo + branch + environment (dev/staging/prod)
- Deployment pipeline on a BullMQ queue: clone → `docker build` → `docker run`
- Live logs via WebSocket (history + streaming through Redis pub/sub)
- Deployment history: commit hash, duration, status, URL
- One-click rollback to any previous successful deployment (re-runs the stored image)
- Encrypted environment variables (AES-256-GCM, write-only API)
- Admin dashboard: deployment stats, 7-day chart, user management
- **Bonus:** GitHub push webhooks (HMAC verified), deployment cancellation, multiple environments

Docs: [Architecture & schema](docs/ARCHITECTURE.md) · [API reference](docs/API.md)

## Quick start (Docker)

Requires Docker with Compose v2.

```bash
cp .env.example .env
# generate real secrets:
#   openssl rand -hex 32   -> ENCRYPTION_KEY
#   openssl rand -hex 32   -> JWT_SECRET
docker compose up -d --build
```
Open http://localhost, register (you become admin), create a project and press **Deploy**.

> The target repo needs a `Dockerfile` at its root that listens on `$PORT` (default 3000). Only public GitHub repos are supported.

## Local development

```bash
docker compose up -d postgres redis      # infra only (add `ports:` mappings 5432/6379 locally)
cd backend
cp ../.env.example .env                  # set DATABASE_URL=postgresql://devflow:<pw>@localhost:5432/devflow
npm install && npx prisma db push
npm run dev          # API on :4000
npm run dev:worker   # worker (needs git + docker on your machine)
cd ../frontend && npm install && npm run dev   # UI on :5173 (proxies /api and /ws)
```

## Tests
```bash
cd backend && npm test
```
Covers encryption, auth flows, RBAC, ownership checks, input validation (repo URL injection attempts) and webhook signature verification. Prisma and the queue are mocked, so no services are needed.

## Deploy to AWS EC2
1. Launch Ubuntu 22.04 (t3.small+), open ports 22, 80 and the app port range 20000–20100 in the security group.
2. `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`
3. `git clone <your-repo> ~/devflow && cd ~/devflow && cp .env.example .env` — set secrets and `PUBLIC_HOST=<ec2-public-ip-or-domain>`, `CORS_ORIGIN=http://<same>`.
4. `docker compose up -d --build`
5. CI/CD: add repo secrets `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY`; every push to `main` runs tests, builds images and redeploys over SSH (`.github/workflows/ci.yml`).

## Security notes
- Passwords: bcrypt (cost 12). JWT 12h; user re-loaded per request so role changes/deletions apply immediately.
- Helmet, CORS allow-list, rate-limited auth routes, zod validation everywhere.
- Repo URL/branch allow-lists + no-shell process spawning prevent command/argument injection.
- Secrets are decrypted only in the worker and passed via a temp env-file (0600) removed after start.
- Production refuses to boot with default `JWT_SECRET` / `ENCRYPTION_KEY`.

## Known limitations / next steps
- **The worker mounts the Docker socket — it is root-equivalent on the host and builds run arbitrary user code.** Fine for a self-hosted/personal setup; for multi-tenant use run builds in isolated VMs/rootless builders.
- Redeploys stop the old container before starting the new one (brief downtime); blue/green behind a reverse proxy is the natural upgrade.
- Schema is applied with `prisma db push`; for a real production flow commit migrations (`npx prisma migrate dev --name init`) and switch to `migrate deploy`.
- Private repos, email/Discord notifications and a CPU/memory monitoring dashboard (`docker stats`) are not implemented.
- HTTPS: put Caddy/nginx + Let's Encrypt in front of the frontend container.

## Submission checklist
- [ ] Push to a public GitHub repo
- [ ] Deploy to EC2 and put the live URL here
- [ ] Render the Mermaid diagrams in `docs/ARCHITECTURE.md` to PNG if the reviewer wants an image
- [ ] Record the 3–5 min demo (register → create project → deploy → live logs → env var → rollback → admin dashboard)
