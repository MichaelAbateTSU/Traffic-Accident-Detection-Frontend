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
VITE_API_BASE_URL=https://your-real-backend.example npm run build

# 4. Preview the production build locally
npm run preview
```

## Connecting to the Backend

By default, the dev server proxies `/api/*` requests to `http://localhost:8000` (configured in `vite.config.js`).

To point to a different backend URL, create a `.env.local` file in the project root:

```env
VITE_API_BASE_URL=http://your-backend-host:8000
```

Functional production builds require a public **HTTPS** `VITE_API_BASE_URL` (including the backend's API prefix, if any). Missing, relative, HTTP, localhost, or credential-bearing URLs fail the build by default. The runtime also shows a configuration error instead of a dashboard if configuration is invalid. The development default is `/api`; Vite's proxy is not available on a static production host. The Settings page displays the actual build-time API URL read-only; browser preferences do not change the connection.

## Free production hosting (GitHub Pages)

This public repository can use GitHub Pages for free static HTTPS hosting. The workflow in `.github/workflows/deploy-pages.yml` tests, builds, and deploys on pushes to `main` or a manual workflow dispatch. It never creates a paid resource. Pages hosts only the frontend; YOLO inference still requires a separately deployed backend. A frontend URL alone does not mean detection is available.

1. In repository **Settings > Pages**, select **GitHub Actions** as the build source.
2. In **Settings > Secrets and variables > Actions > Variables**, set `VITE_API_BASE_URL` to the real public HTTPS backend URL.
3. Configure backend CORS to allow `https://michaelabatetsu.github.io` (origin only, no repository path), GET/POST/PATCH and `Content-Type`/`Authorization`. Expose `Content-Disposition` for CSV filenames.
4. Push the verified configuration to `main` or run **Deploy frontend to GitHub Pages** manually, then verify its successful deployment and backend connectivity.

The workflow explicitly sets `VITE_ALLOW_UNCONFIGURED_BACKEND=true`, so it can publish a **Backend not configured** screen before a backend exists. That screen states that monitoring, detection, and operator access are unavailable; it makes no API requests and does not substitute localhost or a dummy API. The opt-in only allows an absent URL: configured relative, HTTP, localhost, or credential-bearing URLs still fail the build. Once the real `VITE_API_BASE_URL` variable is set, rerun the workflow to enable operator access.

The expected site address is `https://michaelabatetsu.github.io/Traffic-Accident-Detection-Frontend/`; a published unavailable screen is **not a live detection-service claim**. Pages builds use the repository asset base and hash routes, such as `/#/incidents` under the repository path, so refreshing or directly opening nested pages does not produce a Pages 404. Other hosts default to history routing and must rewrite application routes to `index.html`.

All `VITE_*` values are public, embedded in the downloaded JavaScript. Never set a backend token, password, or other secret as a Vite variable.

Production prompts for an **operator token**, verifies it against `/cameras/status`, and sends it as `Authorization: Bearer ...` on API and CSV requests. The token is held only in memory, never in browser storage, query strings, or the build. Sign out or reload to clear it. Use `VITE_REQUIRE_AUTH=true` to enable this prompt with a protected local development backend.

Protected frame images and thumbnails are fetched with authorization only on the configured backend origin and displayed using temporary blob URLs. External images never receive the operator token; redirects are rejected. Object URLs are revoked and in-flight image requests are aborted when the image changes or the view unmounts (including sign out). Opening a frame uses its local blob URL, not an unauthenticated backend link. Original camera source streams remain external public streams and never receive this token. API failures and invalid JSON/CSV/image responses are surfaced explicitly instead of appearing as empty successful results.

To reproduce the Pages build locally:

```bash
VITE_API_BASE_URL=https://your-real-backend.example \
VITE_BASE_PATH=/Traffic-Accident-Detection-Frontend/ \
VITE_ROUTER_MODE=hash npm run build
VITE_BASE_PATH=/Traffic-Accident-Detection-Frontend/ npm run preview
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

Run the focused API URL, Dashboard job-submission, and interleaved camera/incident selection regression checks with `npm test` (Node's VM modules flag supplies Vite's environment and isolated UI dependencies to the test modules; Node may emit an experimental-feature warning).

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
