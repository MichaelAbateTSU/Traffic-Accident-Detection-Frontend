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
VITE_API_URL=http://your-backend-host:8000
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

## API Stubs

`src/services/api.js` contains stub implementations that return hardcoded demo data. Replace each function body with a real `fetch` call once your backend endpoints are ready:

| Function | Expected endpoint |
|---|---|
| `getLiveFrame(cameraId)` | `GET /cameras/{id}/frame` |
| `getCameraStatus()` | `GET /cameras` |
| `getIncidents(limit)` | `GET /incidents?limit={n}` |
| `getStats()` | `GET /stats` |

## Pages

| Route | Page | Description |
|---|---|---|
| `/` | Dashboard | Stats overview + recent incidents |
| `/live` | Live Feed | Camera grid with polling |
| `/incidents` | Incidents | Full incident table with filters |
| `/settings` | Settings | API URL, poll interval, thresholds |
