# FPV Training System V2

Version 2 of the FPV training system for coach-side training operations, public display, TrackDraw track management, equipment statistics, transport planning, AI analysis, and smart voice announcements.

## Highlights

- Real-time FPV training monitor with Web Serial input from the training hub.
- WebSocket live relay for public display pages.
- SQLite persistence for pilots, events, samples, stats, receivers, tracks, equipment, transport rules, and transport plans.
- TrackDraw integration with backend-only API access.
- Automatic equipment recognition from TrackDraw `track` and `overlay` data.
- Manual equipment correction and unknown-object handling.
- Transport plan generation with split trips, sandbag trip splitting, carts, people limits, Gantt chart, and staff assignment.
- Public track display from the home page.
- DeepSeek-compatible LLM API integration for coach assistance.
- AI status analysis for active training events and pilot state.
- Smart voice announcement panel for training reminders, AI suggestions, and event alerts.

## Tech Stack

- Frontend: React + Vite
- Backend: Node.js + Express
- Database: SQLite
- Realtime: WebSocket
- Hardware: Web Serial API
- AI: OpenAI-compatible chat API endpoint, including DeepSeek-compatible deployments

## Quick Start

Install dependencies:

```bash
npm install
```

Build the frontend:

```bash
npm run build
```

Start the backend:

```bash
node server.js
```

Default backend URL:

```text
http://localhost:3000
```

For frontend development:

```bash
npm run dev
```

## Runtime Environment Variables

TrackDraw API key:

```bash
export TRACKDRAW_API_KEY="your_trackdraw_api_key"
node server.js
```

The TrackDraw key is read only by the backend. Do not put it in frontend code.

DeepSeek or other OpenAI-compatible API settings are configured in the coach page UI and stored server-side in SQLite settings. The API key is not exposed in public pages.

## Production Deployment

`npm run build` only creates the frontend output in:

```text
dist/
```

The backend runs directly from:

```text
server.js
```

Minimal production files:

```text
server.js
dist/
package.json
package-lock.json
node_modules/ or npm install on deploy
data/ created at runtime if missing
```

## Main Pages

- Home
  - Training monitor
  - Track display and transport planning
  - Double elimination bracket
  - Coach mode
- Coach mode
  - Pilot library
  - Events and hardware system
  - Track management
  - Live monitor
  - AI coach
  - History
- Public pages
  - Current training track
  - TrackDraw preview
  - Equipment summary
  - Selected transport plan
  - Gantt chart
  - Staff assignment

## TrackDraw Integration

The coach enters:

- TrackDraw API project ID
- TrackDraw preview URL or iframe embed code

Supported preview input examples:

```html
<iframe src="https://trackdraw.app/embed/ExibxxsTn8rxov6d?view=2d" title="TrackDraw track embed"></iframe>
```

The system extracts the iframe `src` automatically.

Backend sync reads:

- `GET /api/v1/me`
- `GET /api/v1/projects/{projectId}`
- `GET /api/v1/projects/{projectId}/track`
- `GET /api/v1/projects/{projectId}/overlay`

## Equipment Recognition

Current rules:

- `gate` -> single gate
- `divegate` -> gravity gate
- `ladder` with `rungs = 2` -> sun gate
- `ladder` with `rungs = 3` -> triple / mu gate
- four ladders inside a 2.5 x 2.5 area -> one double gravity gate
- `sandbag` -> sandbag
- `flag` -> flag
- `startfinish` and `polyline` are ignored

Equipment can be manually corrected before transport planning.

## Transport Planning

The transport planner keeps the important behavior from the original standalone HTML planner:

- equipment task splitting
- sandbag trip splitting
- cart constraints
- max trips per person
- multi-person cooperation tasks
- scoring weights
- Gantt chart output
- staff assignment table

Generated plans are stored in SQLite. Public pages only show the selected plan.

## AI Coach and Voice

Version 2 adds an AI coach page with:

- DeepSeek-compatible API endpoint configuration
- model and API key settings
- structured AI suggestions
- active event summary
- pilot status analysis
- manual AI suggestion generation
- smart voice announcements
- AI suggestion playback
- training rhythm reminders
- long-idle, turtle, long-flight, receiver-offline, and slow-pace alerts

## SQLite Database

Database file:

```text
data/training.db
```

Important tables:

- `pilots`
- `training_events`
- `training_samples`
- `training_segments`
- `training_event_stats`
- `receivers`
- `tracks`
- `track_equipment`
- `track_unknown_objects`
- `transport_rules`
- `transport_plans`
- `training_settings`

## Version 2 Summary

This version adds:

- Track management
- TrackDraw API sync
- equipment recognition and correction
- transport planning
- public track display
- DeepSeek-compatible AI coach
- AI state analysis
- smart voice announcements
- backend-safe deployment without importing frontend source modules at runtime

## License

MIT
