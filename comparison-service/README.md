# Algorithm comparison collector

Railway service root directory: `/comparison-service`.

## Required variables
- `DATABASE_URL`: Railway PostgreSQL connection string
- `COMPARISON_API_TOKEN`: long random shared secret
- `SCORE_FRESH_MS`: optional score freshness threshold (default 120000)
- `PGSSL`: set to `true` only if the database provider requires TLS

## Endpoints
- `GET /health`
- `POST /v1/scores`
- `POST /v1/notifications`
- `POST /v1/match-state`

All `/v1/*` endpoints require `Authorization: Bearer <COMPARISON_API_TOKEN>`.

The service never calls API-Football. It only accepts score snapshots, notification events and match-state updates from the three existing algorithm services.

## Outcome rules
- `hit_10m`: a goal occurs after the notification minute and within 10 match minutes.
- `late_goal`: a goal occurs after the 10-minute window.
- `window_passed`: the 10-minute window elapsed but the match is still ongoing; this is not a failure.
- `no_goal`: the match finished and no later goal occurred.

The collector stores the score from the notifying algorithm and the latest prior score snapshots from the other two algorithms. Peer snapshots are labeled fresh, stale or missing; future snapshots are never used to reconstruct a past notification.
