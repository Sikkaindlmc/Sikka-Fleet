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

The GPS pages use Leaflet with OpenStreetMap tiles and need no map API key. Server-side reverse geocoding uses OpenStreetMap Nominatim, caches resolved addresses, and limits request frequency. Nominatim usage is subject to the OpenStreetMap Foundation's usage policy; set an identifying `NOMINATIM_USER_AGENT` in the backend environment.

GPS Track settings store uploaded running/stopped map icons under `backend/uploads/`;
MongoDB stores their file paths, not the image files. That folder may be erased on
restart or redeploy by many hosting providers. Use persistent object storage (for
example, an S3-compatible bucket) for production icon uploads.

## Start development

```powershell
npm run dev
```

- Frontend: http://localhost:5173
- Backend: http://localhost:5000

The first administrator account is created from the private `ADMIN_USERNAME` and
`ADMIN_PASSWORD` environment variables. Set a strong password before starting the
backend for the first time. Do not put credentials in this README or commit them.

## Build and production

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
