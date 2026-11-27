# SIKKA FLEET

Production-ready fleet and ERP operations application built with React, Express, MongoDB Atlas, Leaflet/OpenStreetMap, PWA support, GPS provider synchronization and geofence automation.

## Prerequisites

- Node.js 20 or newer
- MongoDB Atlas access
- The GPS map uses OpenStreetMap tiles. Readable postal-area locations use the locally imported GeoNames India dataset; an optional LocationIQ or Geoapify key can add street-level details.

## Install

```powershell
cd "D:\Sikka Fleet"
npm install
npm install --prefix frontend
npm install --prefix backend
```

The backend environment is already configured in `backend/.env`. Keep this file private and never commit it.

## Maps and readable locations

The backend looks up the nearest imported GeoNames India postal-area point
using MongoDB's 2dsphere index. The address and distance are cached in MongoDB
for 30 days; an unsuccessful lookup is retried after five minutes. Sync queues
address resolution without waiting, and location popups resolve missing
addresses in a batch. If no place is available, the UI shows six-decimal
coordinates and a Google Maps link.

To optionally enrich a GeoNames result with street or landmark details, set
`GEOCODER_PROVIDER` to `locationiq` or `geoapify` and set `GEOCODER_API_KEY`.
For a self-hosted Nominatim instance, set `GEOCODER_PROVIDER=nominatim`,
`NOMINATIM_REVERSE_URL` to that instance's HTTPS `/reverse` endpoint, and
optionally set `GEOCODER_USER_AGENT`. The backend rejects the public
`nominatim.openstreetmap.org` host; it has no public Nominatim default. Vercel
cannot host Nominatim itself, so the self-hosted service must run separately
and be reachable from the Vercel backend. Do not use the public Nominatim
service for this vehicle-tracking workload.

Only the selected provider is called, by the backend. Requests have a
five-second timeout, two retries with backoff, a shared one-request-per-second
MongoDB limit, a conservative daily quota, and a five-minute failure retry
window. The GeoNames address remains available if enrichment is disabled or
fails. Optional endpoint overrides are `LOCATIONIQ_REVERSE_URL` and
`GEOAPIFY_REVERSE_URL`.

### Import the GeoNames India postal file once

The upstream `IN.zip` archive includes the tab-delimited `IN.txt` postal-code
file and its license/readme. The importer validates the twelve-column rows,
prints a dry-run size estimate, checks the free-tier storage budget, creates
the 2dsphere index, and uses idempotent upserts. It does not remove other
collections or data.

From the repository root in PowerShell:

```powershell
Invoke-WebRequest -Uri "https://download.geonames.org/export/zip/IN.zip" -OutFile ".\IN.zip"
Expand-Archive -Path ".\IN.zip" -DestinationPath ".\geonames-india" -Force
npm --prefix backend run import:geonames -- --file "$PWD\geonames-india\IN.txt"
npm --prefix backend run import:geonames -- --file "$PWD\geonames-india\IN.txt" --apply
```

The first importer command is a dry run. Review its row count and storage
estimate before running the second command. The apply command requires
`MONGO_URI` (or `MONGODB_URI`) and optionally `MONGODB_DB_NAME` in
`backend/.env`; it prints the actual collection/index storage after import.
Remove the downloaded archive and extracted directory after the import if they
are no longer needed.

GeoNames postal-code data is licensed under CC BY 4.0. The app displays
attribution to GeoNames and the license.

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
`ADMIN_PASSWORD`, `WHEELSEYE_API_TOKEN` (plus `WHEELSEYE_API_URL` if needed),
`CRON_SECRET`, and `GEOCODER_PROVIDER`. `GEOCODER_API_KEY` is required for
LocationIQ or Geoapify. Self-hosted Nominatim additionally uses
`NOMINATIM_REVERSE_URL` and optionally `GEOCODER_USER_AGENT`.
`LOCATIONIQ_REVERSE_URL` and
`GEOAPIFY_REVERSE_URL` are optional overrides; their defaults are listed in
`backend/.env.example`. The offline GeoNames address lookup requires no
geocoder key.
The frontend uses same-origin `/api` by default; only set the build-time
`VITE_API_BASE_URL` when deploying the API on a different origin. Set
`ALLOWED_ORIGINS` to a comma-separated list of exact trusted origins if the API
is called from a different domain; do not use `*`.

Vercel Functions do not keep a persistent scheduler process. Configure a
cron-job.org job to request `https://<your-domain>/api/sync/cron` every 30
minutes using the `GET` method and the header
`Authorization: Bearer <CRON_SECRET>`. Set `CRON_SECRET` in the Vercel
environment and in cron-job.org's request header. The endpoint updates the
persisted scheduler heartbeat and schedule used by the dashboard countdown.
If scheduled calls stop, the UI reports Auto Sync as inactive.

Generate a strong `CRON_SECRET` locally with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Keep the value private; do not put it in source control or frontend variables.
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

## GPS synchronization

Manual Sync and the protected cron endpoint synchronize WheelsEye. A failed or
empty response does not replace the last good GPS data.

Plant plans are automatically removed one hour after the vehicle's GPS-recorded
exit from that plant. Plans created after the recorded exit are not affected.
