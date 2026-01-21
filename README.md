# BRIN Backend

This service is a Fastify-based backend that mirrors the Base44 API surface the frontend currently depends on. It exposes data in MVC style, keeps business logic (flows + services) separate, and stores records in PostgreSQL.

## Features

- Fastify + `fastify-autoload` wiring for plugin/route directories
- Centralized config loaded from `.env.{environment}` via `cross-env`
- MVC pattern with services, repositories, controllers, and domain flows (see `NotificationFlow` for an example)
- PostgreSQL connection via `pg` and a shared `entity_records` table so every frontend entity can be stored without creating dozens of tables
- Notification-specific APIs and an integration stub (`/integration-endpoints/Core/SendEmail`) that the frontend can call exactly the same way it calls Base44
- Authentication guard that reuses demo tokens defined through environment variables (so you can run `Authorization: Bearer brins-demo` in dev)

## Environment

Each script loads a separate `.env` file using `cross-env`:

| Script | Purpose | Env file |
| --- | --- | --- |
| `npm run dev` | Development with `nodemon` | `.env.development` |
| `npm run staging` | Starts `NODE_ENV=staging` | `.env.staging` |
| `npm run start` | Production-ready server | `.env.production` |

Copy `.env.example` to the env file you need and fill in the database credentials / tokens before running.

## Database setup

Create a PostgreSQL database for each environment and run `database/schema.sql`. Example:

```sql
CREATE DATABASE brin_dev;
\c brin_dev
\i database/schema.sql
```

The service expects the following tables:

- `entity_records` stores every entity payload the frontend persists, plus metadata (UUID, timestamps)
- `notifications` holds manual notifications so the UI can show badge counts and audit trails

## Running locally

```bash
npm install
npm run dev
```

Fastify will listen on the configured `PORT` (default `4000`) and log on startup.

## API surface

| Feature | Method | Endpoint | Auth | Description |
| --- | --- | --- | --- | --- |
| Public settings | `GET` | `/api/apps/public/:environment/public-settings/by-id/:appId` | no | Mirrors `appClient.get` used by `AuthContext` to retrieve `{ public_settings }`. |
| Login | `POST` | `/api/apps/:appId/auth/login` | no | Demo login that accepts the email configured via `.env` and the shared `DEMO_PASSWORD`. Returns `{ token, user }`. |
| Current user | `GET` | `/api/apps/:appId/entities/User/me` | yes | Same as the Base44 `auth.me()` endpoint. Requires a bearer token such as `brins-demo`. |
| Entities CRUD (Debtor, Batch, Claim, etc.) | `GET/POST/PUT/DELETE` | `/api/apps/:appId/entities/:entityName` (+ `/:id`) | yes | Generic CRUD backed by `entity_records` if `entityName` is supported. Allowed names include `Debtor`, `Batch`, `Claim`, `Nota`, `Notification`, `PaymentIntent`, etc. |
| Notifications | `GET/POST/PUT/DELETE` | `/api/notifications` | yes | Richer controller that lists notifications, marks them as read, updates content, and deletes entries. |
| App logs | `POST` | `/api/app-logs/:appId/log-user-in-app/:pageName` | yes | Logs user navigation events, matching the path `base44.appLogs.logUserInApp` uses. |
| Core integration stub | `POST` | `/api/apps/:appId/integration-endpoints/Core/SendEmail` | yes | Accepts the same payload the frontend would send and returns a queued response. |

## Next steps

- Sink `entity_records` data into normalized tables (Debtor, Batch, etc.) when the real schema is known
- Add migrations or Prisma if you want richer modeling or automated seed data
- Replace demo auth with JWT / OAuth once the real identity provider is available
- Hook notifications + email sends into external services (e.g., SES, SendGrid)
 - Maintain the Prisma schema (`prisma/schema.prisma`) so `entity_records` and `notifications` stay aligned with the database. Use `npx prisma migrate deploy`/`npx prisma generate` in CI when the schema changes.
