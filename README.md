# SIKKA FLEET

Production-ready fleet and ERP operations application built with React, Express, MongoDB Atlas, Leaflet/OpenStreetMap, PWA support, GPS provider synchronization and geofence automation.

## Prerequisites

- Node.js 20 or newer
- MongoDB Atlas access
- No paid map API key is required. Leaflet maps use OpenStreetMap tiles and Nominatim reverse geocoding.

## Install

```powershell
cd "D:\Sikka Fleet"
npm install
npm install --prefix frontend
npm install --prefix backend
```

The backend environment is already configured in `backend/.env`. Keep this file private and never commit it.

## Maps and readable locations

The GPS pages use OpenStreetMap tiles with visible attribution and need no paid map API key. Reverse geocoding is optional and supports the Nominatim JSONv2 API through `NOMINATIM_URL`. It is disabled when unset and rejects known public OpenStreetMap Nominatim hosts; only configure a self-hosted instance you control. Provider-supplied and cached addresses continue to work, and coordinates remain available when lookup is disabled. Self-hosting Nominatim requires compute, storage, and importing OpenStreetMap data; those infrastructure costs depend on the host and region, but no paid geocoding API is required.

The long-running local/Render backend stores uploaded map icons under
`backend/uploads/`. The Vercel serverless deployment stores them in MongoDB
instead because its function filesystem is not durable.

## Start development

```powershell
npm run dev
```

- Frontend: http://localhost:5173
- Backend: http://localhost:5000

The first administrator account is created from the private `ADMIN_USERNAME` and
`ADMIN_PASSWORD` environment variables. Set a strong password before starting the
backend for the first time. Do not put credentials in this README or commit them.

## Deploy to Vercel

Deploy this repository as a single Vercel project with the repository root as its
Root Directory. The root `vercel.json` builds the Vite frontend from `frontend/`
and publishes `frontend/dist`; `api/index.js` forwards `/api`, `/uploads`, and
`/share` requests to the Express application as serverless functions.

Use the root `npm run build` command and set the Output Directory to
`frontend/dist` (or leave it to `vercel.json`). Configure these environment
variables in Vercel for every required environment: `MONGO_URI` (or
`MONGODB_URI`), `MONGODB_DB_NAME`, `JWT_SECRET`, `ADMIN_USERNAME`,
`ADMIN_PASSWORD`, and `WHEELSEYE_API_TOKEN` (plus `WHEELSEYE_API_URL` if needed).
Optionally set `NOMINATIM_URL` to the `/reverse` endpoint of your self-hosted
Nominatim instance and `NOMINATIM_USER_AGENT` to an identifying application name.
Do not set the endpoint to a public Nominatim host.
The frontend uses same-origin `/api` by default; only set the build-time
`VITE_API_BASE_URL` when deploying the API on a different origin. Set
`ALLOWED_ORIGINS` to a comma-separated list of exact trusted origins if the API
is called from a different domain; do not use `*`.

Vercel Functions do not keep a persistent scheduler process. The
`.github/workflows/gps-auto-sync.yml` workflow calls the protected production
endpoint every 30 minutes and reuses the backend's persisted schedule and
distributed lock. It runs independently of browsers and uses GitHub-hosted
runners, which are free for this public repository. GitHub scheduled workflows
are best-effort: GitHub may delay or drop a scheduled run, so this is not a
hard real-time guarantee. The backend heartbeat expires if scheduled calls
stop, and the UI then reports Auto Sync as inactive.

Vercel Hobby Cron only supports one run per day, so it cannot run this schedule;
see Vercel's [Cron limits](https://vercel.com/docs/schedules/cron-jobs/usage-and-pricing).
To enable the GitHub schedule, configure `GPS_SYNC_SCHEDULER_SECRET` as a
Production environment variable in Vercel (**Project Settings > Environment
Variables**) and as a repository Actions secret (**Settings > Secrets and
variables > Actions**) with the same value. Generate a strong value locally
with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Keep the value private; do not put it in source control or frontend variables.
Commit the workflow to the repository's default branch and enable GitHub Actions.
Vercel's API function is configured for a maximum 300-second execution, subject
to the current Vercel plan's limits and usage. If an already-running persistent
backend scheduler has a healthy heartbeat in the shared database, the external
trigger will not start a second synchronization. Do not deploy an additional
Render worker for this setup.

Icon uploads are stored in MongoDB when running on Vercel (up to 1 MB per image).
The Dashboard reads the persisted production schedule and refreshes sync state
and fleet data while open.

## Local production build

```powershell
npm run build
$env:NODE_ENV="production"
npm start
```

Express serves the built frontend on port 5000 in production.

## Deploy

1. Deploy MongoDB Atlas and allow the application host IP/network.
2. Set all variables from `backend/.env.example` in the host environment.
3. Set `NODE_ENV=production`, `PORT=5000`, and a secure `JWT_SECRET`.
4. Build the frontend and start Express with `npm run build && npm start`.
5. Enable HTTPS. Cookies use the Secure flag in production.

## GPS providers

The cron job synchronizes providers every 30 minutes. Use **Sync Now** for manual synchronization. Provider failures are isolated and stale data is retained.

Plant plans are automatically removed one hour after the vehicle's GPS-recorded
exit from that plant. Plans created after the recorded exit are not affected.
