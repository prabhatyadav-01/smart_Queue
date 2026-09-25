# SmartQueue — Smart Public Service Queue Management System

Digital tokens, appointments and live queues for government offices, hospitals,
banks and company front desks. **Skip the queue. Not the service.**

Migrated to **Supabase Postgres** and **Supabase Auth with Google OAuth**.

---

## Quick Start

```bash
npm install
npm test             # 46 unit, service, concurrency, and API tests
npm run dev          # http://localhost:3000 (starts with auto-fallback or Supabase)
```

Requires **Node.js 22.13+**.

### In-Memory vs. Live Supabase Postgres

- **Zero-config Local Dev / Testing**: If `DATABASE_URL` is omitted in development, SmartQueue boots an in-memory PostgreSQL engine (`pg-mem`) automatically. You do not need any external database to test or run locally.
- **Production / Live Supabase**: Configure `DATABASE_URL` or `SUPABASE_DB_URL` in `.env` to connect to Supabase Postgres.

On first start the console prints a one-time **admin password** for `admin@smartqueue.local`. Sign in at `/login.html` and link an authenticator app (TOTP). Admin and staff accounts always require two-factor authentication. The dashboard is accessible at `/admin.html`.

---

## Supabase & Database Architecture

SmartQueue is powered by PostgreSQL hosted on Supabase:

- **Schema Definition**: [supabase/migrations/20260310000000_smartqueue_schema.sql](file:///supabase/migrations/20260310000000_smartqueue_schema.sql)
- **Data Migration Dump**: [supabase/migrations/20260310000001_migrated_data.sql](file:///supabase/migrations/20260310000001_migrated_data.sql)
- **Automated Migration Tool**: `npm run migrate`

### Running Migrations to Supabase

1. Set your Supabase connection string in `.env` (or pass it directly):
   ```bash
   DATABASE_URL="postgresql://postgres:[YOUR-PASSWORD]@db.[YOUR-PROJECT-REF].supabase.co:5432/postgres" npm run migrate
   ```
2. The migration tool creates the full schema, triggers, partial unique indexes, identity sequences, and populates all organisations, services, counters, bookings, audit logs, and risk events.

---

## Supabase Auth & Google OAuth Setup

SmartQueue supports two-factor authentication via Supabase Auth (Google OAuth) or email/password with TOTP:

1. **Supabase Project Settings**:
   - In your Supabase Dashboard, go to **Authentication -> Providers -> Google**.
   - Enable Google and enter your Google OAuth **Client ID** and **Client Secret** (from Google Cloud Console).
   - In Google Cloud Console, add the Supabase callback URL to Authorized redirect URIs:
     `https://<project-ref>.supabase.co/auth/v1/callback`
   - In Supabase Dashboard -> **URL Configuration**, set the Site URL to `http://localhost:3000` (or your production domain).
2. **Server-Side Identity Verification**:
   - Supabase access tokens are verified server-side with `@supabase/supabase-js`.
   - New users registered via Google/Supabase Auth are automatically mapped with `role = 'user'`, preventing privilege escalation.
   - Admin and staff privileges can only be assigned by existing administrators.

---

## Environment Variables

Copy `.env.example` to `.env`:

```env
PORT=3000
NODE_ENV=development

# Database (Supabase PostgreSQL pooler or direct connection)
DATABASE_URL=postgresql://postgres:[password]@db.[project-ref].supabase.co:5432/postgres

# Supabase Auth & Client
SUPABASE_URL=https://[project-ref].supabase.co
SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

# Google OAuth (Optional if using Supabase Google provider directly)
GOOGLE_CLIENT_ID=your_google_client_id.apps.googleusercontent.com

# Initial Administrator Credentials
ADMIN_EMAIL=admin@smartqueue.local
ADMIN_PASSWORD=

# Session Security & Encryption
APP_SECRET=
DEMO_MODE=1
```

---

## What's Inside

| Feature | How it works |
|---|---|
| **Token generation** | `token = slot × capacity + seat + 1`, so the number depends only on *your* time slot. Walk-ins get the next free seat today. |
| **Appointments** | Book up to 14 days ahead. Rescheduling changes **only your token**, and everyone else keeps theirs. |
| **Live queue** | Server-Sent Events push a per-centre snapshot (counters, waiting list, KPIs) the instant anything changes. |
| **Counter assignment** | Only **checked-in** tokens are called, earliest slot first. Auto-assign fills free counters, least-busy first. |
| **Geofenced check-in** | The browser's location is compared to the centre's geofence (radius + GPS accuracy, capped). Inside means checked in, and leaving puts the token on hold. |
| **Absent users** | Reminder 15 min before the slot. 10 min after the slot, if not checked in, the token **moves to a later free slot** without shifting anyone else. After 2 moves it expires and counts as a no-show strike. |
| **Notifications** | In-app feed and toasts over SSE, plus browser notifications when allowed. The "your turn" alert also vibrates the phone. |
| **Admin dashboard** | Counters (call, complete, recall, no-show, pause), today's queue with desk check-in, hourly and status charts, geofence editor, bot signals and audit log. |

---

## Security & Concurrency Guarantees

- **Database-Level Double-Booking Prevention**: A Postgres **partial unique index** `ux_bookings_seat ON bookings(service_id, date, slot_index, seat) WHERE status NOT IN ('cancelled', 'no_show')` guarantees that double-issuing a seat is physically impossible, even under high concurrency.
- **Transaction Safety**: Seat reservation and token issuance occur inside explicit PostgreSQL transactions with `AsyncLocalStorage` transaction context management.
- **Two-Factor Sign-in**: Google OAuth via Supabase Auth with server-side identity verification, or email/password with TOTP authenticator. TOTP seeds are AES-256-GCM encrypted at rest.
- **Bot Detection & Abuse Prevention**: Server-side cursor and typing timing telemetry scoring; honeypot traps; strict rate limiting on bookings, location updates, and authentication endpoints.

---

## Project Layout

```
server/
  app.js, index.js      Express application & server entry point
  db.js                 Postgres database access pool & transactions (pg + pg-mem fallback)
  services/             booking, presence (geofence), counters, stats, notifier
  routes/               auth, public, bookings, admin
  middleware/           sessions, human check, CSRF / rate limits / audit
  lib/                  supabase, slots, geo, botScore, crypto, SSE hub
public/
  index.html            landing page with live widgets
  login.html app.html admin.html
  css/tokens.css        design tokens
supabase/
  migrations/           schema & data migrations for Supabase Postgres
scripts/
  migrate.js            automated migration runner
tests/                  unit, concurrency, and API test suites
```
