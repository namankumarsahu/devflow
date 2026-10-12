# API Reference

Base URL: `/api`. JSON in/out. Authenticated routes need `Authorization: Bearer <jwt>`.
Errors: `{ "error": "message", "details"?: {field: [msgs]} }`.

## Auth
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/register` | `{email, password(min 8)}` | First user becomes `ADMIN`. Returns `{token, user}`. Rate limited. |
| POST | `/auth/login` | `{email, password}` | Returns `{token, user}`. |
| GET | `/auth/me` | — | Current user. |

## Projects
| Method | Path | Notes |
|---|---|---|
| POST | `/projects` | `{name, repoUrl: "https://github.com/o/r", branch?, environment?: DEVELOPMENT\|STAGING\|PRODUCTION, containerPort?}` |
| GET | `/projects` | Own projects (admins see all). |
| GET | `/projects/:id` | Includes `webhookSecret`. |
| PATCH | `/projects/:id` | Partial update (not `repoUrl`). |
| DELETE | `/projects/:id` | Deletes data and queues container teardown. |
| POST | `/projects/:id/deploy` | `202` + Deployment (QUEUED). |
| GET | `/projects/:id/deployments?limit=50` | History: commit, duration, status, url. |

## Environment variables
| Method | Path | Notes |
|---|---|---|
| GET | `/projects/:id/env` | Keys only — values are never returned. |
| PUT | `/projects/:id/env` | `{key, value}` upsert (encrypted). |
| DELETE | `/projects/:id/env/:key` | |

## Deployments
| Method | Path | Notes |
|---|---|---|
| GET | `/deployments/:id` | |
| GET | `/deployments/:id/logs` | Persisted log lines. |
| POST | `/deployments/:id/rollback` | Target must be `SUCCESS`. Creates a new deployment re-running that image. |
| POST | `/deployments/:id/cancel` | Works for QUEUED / BUILDING / DEPLOYING. |

Status lifecycle: `QUEUED → BUILDING → DEPLOYING → SUCCESS | FAILED | CANCELLED`.

## Live logs (WebSocket)
`ws(s)://<host>/ws/logs?deploymentId=<id>&token=<jwt>`

Server sends history first, then live messages:
```json
{"type":"log","line":"==> Building image …","ts":1730000000000}
{"type":"status","status":"SUCCESS"}
```
Close codes: `4401` unauthorized, `4403` forbidden.

## GitHub webhook
`POST /webhooks/github/:projectId` — configure in GitHub with content type `application/json`, event `push`, and the project's secret. Verified with `X-Hub-Signature-256` (HMAC-SHA256, constant-time compare). Only pushes to the project's tracked branch trigger a deployment.

## Admin (ADMIN role)
| Method | Path | Notes |
|---|---|---|
| GET | `/admin/stats` | Totals, status breakdown, success rate, avg duration, last-7-days series. |
| GET | `/admin/users` | |
| PATCH | `/admin/users/:id` | `{role}` — cannot change self. |
| DELETE | `/admin/users/:id` | Cannot delete self. |

## Health
`GET /health` → `{ok:true}`
