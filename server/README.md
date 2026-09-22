# Backend structure

`server.js` is the composition root: it creates Express/HTTP, wires feature
dependencies, starts timers, serves `dist/`, and listens for connections. Keep
business rules out of the entry file where possible.

## Modules

- `config/loadEnv.js`: local `.env` parser used before app startup.
- `database/initializeDatabase.js`: schema creation and additive migrations.
- `shared/json.js`: defensive JSON and AI-response parsing helpers.
- `integrations/qweather.js`: QWeather JWT signing and API access. The private
  key can come directly from an environment variable; no root-level PEM is
  required.
- `live/sampleProcessing.js`: CRSF/PWM conversion and telemetry normalization.
- `transport/planner.js`: pure transport-plan search and scoring.
- `features/tracks/registerTrackRoutes.js`: track, equipment, TrackDraw, and
  transport-plan routes.
- `features/training/createTrainingRuntime.js`: telemetry persistence, receiver
  state, CSV buffering, statistics refresh, and live-state construction.
- `features/coach/registerCoachFeature.js`: coach snapshots, LLM requests,
  history summaries, and coach authentication.
- `features/teaching/registerTeachingRoutes.js`: skill tree, lesson planning,
  reviews, weather, coach tasks, and teaching routes.

Feature registration functions receive their dependencies explicitly. When a
feature needs functionality from another feature, expose the smallest useful
function rather than importing the entry file or accessing new globals.
