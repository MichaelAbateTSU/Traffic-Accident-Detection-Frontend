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

## Free production hosting (Render static site)

`render.yaml` defines a **static site**, not a paid Node web service or an inference server. It preserves the separate GitHub Pages workflow. **Render deployment is prepared, not live:** no authorized Render account is connected and no public backend URL is available yet. A working frontend does not host YOLO or make the backend continuously available.

1. Sign in to your existing authorized Render account and connect this repository. Choose **New > Blueprint** and use the root `render.yaml` on `main` after these changes are merged. Review that the resource is a **Static Site** and do not add paid resources. Alternatively, choose **New > Static Site** with branch `main`, build command `npm ci && npm test && npm run build:render`, publish directory `dist`, and Node version `22`.
2. When a backend exists, supply `VITE_API_BASE_URL` with its actual public HTTPS base URL, including its API prefix if needed. The Blueprint prompts for this value (`sync: false`); it is public build configuration, **not a secret**. Until then, leave it unset/empty and explicitly set `VITE_ALLOW_UNCONFIGURED_BACKEND=true` to publish only the **Backend not configured** screen. The Blueprint includes that opt-in. If Blueprint creation requires a nonempty URL, use the manual Static Site setup and omit `VITE_API_BASE_URL`; never invent a URL. Do not add an operator token to Render environment variables. For manual setup, also set `NODE_VERSION=22`.
3. For manual setup, add **Redirects/Rewrites**: source `/*`, destination `/index.html`, action **Rewrite**. The Blueprint includes this rule. Existing files remain served normally; unknown client routes load the app. The Render build explicitly uses root assets (`/`) and history routing, so `/incidents`, `/settings` and `/camera/:id` must survive direct navigation and refresh.
4. Configure backend CORS to allow the **actual Render site origin** shown in its dashboard, such as `https://<assigned-name>.onrender.com`, without a trailing slash/path. Allow GET/POST/PATCH and `Content-Type`/`Authorization`, and expose `Content-Disposition`. Keep the backend token and exact source allowlist on the backend; deploying a frontend does not approve any video source.
5. Deploy, open the assigned HTTPS URL, sign in with the operator-entered token, and verify a permitted job, terminal status, saved frames, and a refreshed nested route. Do not describe detection as live until this succeeds against the real backend.

The build runs the existing tests and `build:render`, which overrides any Pages base/hash settings. Without the explicit unavailable-backend opt-in, a missing backend URL fails with the existing public-HTTPS configuration error. With it, the unavailable screen states that monitoring, detection and operator access are disabled and makes no API requests. Invalid configured URLs always fail, even with the opt-in; there is no localhost/dummy fallback or fake live dashboard. API authentication and token memory-only handling are unchanged. Updating `VITE_API_BASE_URL` requires a new build/deploy; changing the GitHub Actions repository variable alone does not change Render. Once configured, the opt-in may be removed or set to `false` to require a backend URL on future builds.

To reproduce the Render build locally on Windows, macOS or Linux, set the public configuration in an untracked `.env.local` file:

```env
VITE_API_BASE_URL=https://your-real-backend.example
VITE_BASE_PATH=/
```

Then run:

```bash
npm test
npm run build:render
npm run preview
```

To build just the unavailable screen, remove `VITE_API_BASE_URL` and legacy `VITE_API_URL` from both the environment and `.env.local`, add `VITE_ALLOW_UNCONFIGURED_BACKEND=true` to `.env.local`, and run `npm run build:render`. The Node build entry point forces root assets and history routing even if ambient environment variables or local files contain Pages settings; it does not override backend URL validation or the unavailable-state opt-in. Preview defaults to `/`; remove any ambient Pages `VITE_BASE_PATH` before previewing.

Render static hosting provides HTTPS/CDN delivery without a continuously running application process. Its free usage is subject to the account's current included outbound bandwidth and build-pipeline limits; it is not an unlimited-capacity or availability guarantee. Check [static-site documentation](https://render.com/docs/static-sites), [free-service limits](https://render.com/docs/free), and [pricing](https://render.com/pricing) before enabling deployment, and do not authorize paid overages or upgrades. Exact current quotas could not be verified from this implementation environment. Backend hosting is separate: a free Render web service can idle/spin down, restart and lose ephemeral files, and has resource/usage limits; it does **not** guarantee always-on YOLO inference or durable saved frames. Do not switch the backend to a paid instance to work around these limits without explicit authorization.

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
    Dashboard/      Overview: stats + recent alarm-frame records
    LiveFeed/       Live YOLO-processed camera streams
    Incidents/      Full alarm-frame record history with status filters
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

Accident scores (`confidence_score`, `peak_confidence`, and `raw_score` in the API) are 0-1 weighted heuristics from `AccidentScorer`; the accident/peak scores are smoothed. They are **not calibrated accident probabilities** or YOLO object-detection confidence. The UI displays them as decimal heuristic scores, with matching filter/sort labels. API field names, numeric values, sorting, and filtering remain unchanged. YOLO's confidence for individual object detections is a separate quantity.

Event `timestamp_sec` is displayed as **processing elapsed time**: wall-clock seconds since job start, not a source-video/media timestamp. The API value is unchanged.

**Alarm-frame records, not unique accidents:** the backend emits one event/incident record per processed frame while its heuristic alarm is active. Consecutive records can belong to one alarm episode; neither a record nor its score confirms an accident. The UI preserves every record without grouping, discarding or deduplicating it. `incidents_today` is displayed as **Alarm Frames Today**, not a count of unique accidents. API `active`/`resolved` values are displayed as **Record active/Record resolved**. The automatic default is active while the source job is pending/running and resolved when it finishes; a PATCH can override it. `manually_updated` identifies a manual override, not proof of review. Neither status confirms operator review, physical accident resolution or a current live alarm.

**Legacy nonfailed-job ratio, not system uptime:** the compatibility field `uptime_percent` counts nonfailed jobs among at most 10,000 listed jobs in the backend window (including queued/running), divided by the total matching jobs in that window. Thus restored histories larger than 10,000 can undercount the numerator; it is not an unconditional proportion of all nonfailed jobs. The dashboard's 30-day ratio displays the backend value unchanged and explains that an empty window returns 100%. This convention is not evidence of availability or successfully completed inference; the UI does not invent a denominator or label the metric as measured uptime.

**Recent Alarm Frames** requests all record statuses, so retained completed-job records remain visible after their automatic transition to resolved. The total describes retained records across all statuses, not unique accidents. The separate active-record banner counts only active-status records on the currently displayed page, not a global active count; the Alarm Frames page retains explicit status filters.

- **Detection job batches** — the Dashboard retains and monitors jobs already accepted if a later camera submission fails. A separate submission warning reports the partial failure and remains visible during successful polling, until another batch is started. Overlapping starts are blocked while submission is in progress or accepted jobs are pending/running; all accepted jobs must finish before a new batch can replace the monitor.
- **Monitor recovery** — non-secret accepted job IDs and partial-submission warnings are saved per backend URL in browser storage, never the operator token. After navigation or reload/re-authentication, the Dashboard restores saved jobs and paginates the backend's pending/running job listing before permitting new submissions. Listing/recovery failures display a retry action and keep new batches blocked. Expired jobs (404) are explicitly marked failed/unavailable; uncertain job-status failures remain monitored. Recent Jobs includes nine jobs, enough for one full camera batch.
- **Frames per source** — the Dashboard defaults to 120 frames per source and accepts whole numbers from 1 to 300. Every camera or single-video submission includes the selected `max_frames`; invalid values do not submit jobs or clear the current monitor. Shared submission, recovery and result messages refer to detection jobs, not an assumed camera batch. Jobs are bounded, not continuous monitoring, and remain polled until complete or failed. Direct API callers may omit `max_frames` to retain the backend's legacy five-frame default.
- **Single approved video** — a separate Dashboard form submits one HTTPS video source using the same frame-count/Save frames controls and monitor. The operator must approve the **exact URL** in the backend source allowlist; rejection is displayed, not bypassed. Optional linked [ACCIDENT benchmark](https://accidentbench.github.io/) examples select 200 frames and Save frames without auto-submitting or downloading media into this repository. The source reports **CC BY-NC-SA 4.0 (noncommercial)** restrictions. CSV onset metadata is shown for `tbone (3)` (frame 18, 0.72 s; website label differs from CSV category) and `single (3)` (frame 148, 6.644433 s; at least 149 decoded frames). Index conventions and model accuracy are not verified; source timing is not the backend's processing elapsed time.
- **Override record status** — the alarm-frame detail panel (Dashboard and Alarm Frames pages, still `/incidents`) has *Set record resolved* / *Set record active* buttons and an operator note (max 500 characters). These preserve the API's `resolved` / `active` values and override its automatic job-derived default; they do not clear the heuristic alarm or certify review. The backend persists operator state when its durable SQLite configuration is enabled; records remain subject to job retention/expiry.
- **Export alarm-frame records** — the *Export CSV* button on the Alarm Frames page downloads every record matching the current filters and sort order, using the unchanged `/incidents/export` endpoint and CSV fields.
- **Saved / latest detection frames** — enable *Save frames* in the Dashboard's Detection Job Monitor before starting a job to see saved frame images. The single-camera view (`/camera/:id`) shows the most recent saved annotated frame for that camera, refreshed every 10 seconds. Save frames is unchecked by default: jobs started with `save_frames=false` still run detection but produce no frame images.

Saved-frame galleries in the Dashboard and job cards display three frames (nine images) per page, with Previous/Next and direct page selection preserving access to all 300 frames per job. Progressive polling updates the available pages without changing the selected page. Lazy images start authenticated blob requests only when near the viewport; changing pages unmounts images, aborts requests, and revokes object URLs. Browsers without IntersectionObserver still fetch only the bounded rendered page.

**Raw playback versus detection-job state:** Live Feed and Camera View attempt configured raw camera streams independently of the latest detection job. `/cameras/status` wire values are job-derived: `online` means pending/running, `warning` means failed, and `offline` means complete. Missing records/status are displayed as unknown, never assumed online. These values do not measure source health; completion/failure cannot disable raw playback. Browser/HLS/media failures are surfaced separately, and video controls permit manual playback when autoplay is blocked. Raw source requests never carry the operator token and may fail independently because of browser support, CORS or the source host.

Dashboard source counts describe distinct retained job sources, not cameras proven online; `0/0` means no retained job sources. Camera timestamps are job-derived timestamps, not source heartbeats or evidence of live availability. The Camera View's authenticated latest saved YOLO-processed frame is a separate bounded-job artifact, not a continuous processed live stream. Live Feed refreshes job metadata only, not source-health probes.

## Pages

| Route | Page | Description |
|---|---|---|
| `/` | Dashboard | Stats overview + recent alarm-frame records |
| `/live` | Live Feed | Raw camera playback grid with detection-job metadata refresh |
| `/incidents` | Alarm Frames | Full alarm-frame record table with status filters, manual overrides, CSV export |
| `/camera/:id` | Camera View | Raw stream playback and separate latest saved YOLO frame |
| `/settings` | Settings | API URL, poll interval, thresholds |
