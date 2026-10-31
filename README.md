# Traffic Accident Detection — Frontend

A React + Vite web dashboard for monitoring highway cameras and viewing YOLO-powered accident detection results in real time.

## Tech Stack

- **React 18** + **JavaScript**
- **Vite 6** — dev server & build tool
- **React Router v6** — client-side routing
- **CSS Modules** — scoped component styles

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- npm v9 or later

### Install & Run

```bash
# 1. Install dependencies
npm install

# 2. Start the development server (http://localhost:3000)
npm run dev

# 3. Build for production
npm run build

# 4. Preview the production build locally
npm run preview
```

## Connecting to the Backend

By default, the dev server proxies `/api/*` requests to `http://localhost:8000` (configured in `vite.config.js`).

To point to a different backend URL, create a `.env.local` file in the project root:

```env
VITE_API_BASE_URL=http://your-backend-host:8000
```

## Project Structure

```
src/
  components/
    AlertBanner/    Dismissable notification strip
    CameraCard/     Single camera feed with frame polling
    IncidentTable/  Sortable incident log table
    Navbar/         Top navigation bar
    StatCard/       Dashboard metric card
    StatusBadge/    Online / Warning / Offline pill
  pages/
    Dashboard/      Overview: stats + recent incidents
    LiveFeed/       Live YOLO-processed camera streams
    Incidents/      Full incident history with filters
    Settings/       API config & detection preferences
  services/
    api.js          Backend API wrapper (stub → real)
  App.jsx           Router setup
  main.jsx          React entry point
  index.css         Global reset & CSS variables
```

## Backend API

`src/services/api.js` wraps the backend's `{ data, meta, error }` envelope and maps snake_case payloads to UI-friendly objects. Root-relative artifact URLs returned by the backend (e.g. `/artifacts/<job>/capture/000001.jpg`) are resolved against the API origin, so frame images load even when the UI runs on a different origin than the API. With `VITE_API_BASE_URL=http://host:8000/api/v1`, `/api/v1/artifacts/...` resolves to `http://host:8000/api/v1/artifacts/...` without duplicating the prefix. Relative artifact paths use the full API base; absolute, protocol-relative, data, and blob URLs are unchanged. A relative API base keeps root-relative artifact paths on the UI's origin.

Run the focused API URL and Dashboard job-submission regression checks with `npm test` (Node's VM modules flag supplies Vite's environment and isolated UI dependencies to the test modules; Node may emit an experimental-feature warning).

| Function | Endpoint |
|---|---|
| `getDashboard(options)` | `GET /dashboard` |
| `getStats(options)` | `GET /stats/overview` |
| `getCameraStatus()` | `GET /cameras/status` |
| `getCameraLatestFrame(cameraId)` / `getLiveFrame(cameraId)` | `GET /cameras/{id}/latest-frame` (returns `null` on 404) |
| `getIncidents(options)` | `GET /incidents` |
| `getIncidentById(id)` | `GET /incidents/{id}` |
| `updateIncidentStatus(id, { status, note })` | `PATCH /incidents/{id}` |
| `exportIncidentsCsv(filters)` | `GET /incidents/export` (downloads a CSV file) |
| `startDetectionJob(payload)` | `POST /detect-accident` |
| `getJobs`, `getJob`, `getJobStatus`, `getJobDetections` | `GET /jobs…` |
| `getHealth()` | `GET /health` |

### Operator workflows

- **Detection job batches** — the Dashboard retains and monitors jobs already accepted if a later camera submission fails. A separate submission warning reports the partial failure and remains visible during successful polling, until another batch is started.
- **Resolve / reopen incidents** — the incident detail panel (Dashboard and Incidents pages) has *Mark resolved* / *Reopen incident* buttons and an operator note (max 500 characters). Changes are held in backend memory and reflected in lists, the dashboard, and CSV exports while the associated job is retained. They are lost when the backend restarts or the job expires; they are not durably persisted.
- **Export incidents** — the *Export CSV* button on the Incidents page downloads every incident matching the current filters and sort order.
- **Saved / latest detection frames** — enable *Save frames* in the Dashboard's Detection Job Monitor before starting a job to see saved frame images. The single-camera view (`/camera/:id`) shows the most recent saved annotated frame for that camera, refreshed every 10 seconds. Save frames is unchecked by default: jobs started with `save_frames=false` still run detection but produce no frame images.

## Pages

| Route | Page | Description |
|---|---|---|
| `/` | Dashboard | Stats overview + recent incidents |
| `/live` | Live Feed | Camera grid with polling |
| `/incidents` | Incidents | Full incident table with filters, resolve/reopen, CSV export |
| `/camera/:id` | Camera View | Full-screen stream with latest detection frame |
| `/settings` | Settings | API URL, poll interval, thresholds |
