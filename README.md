# BASTARD Feedback API

Backend for BASTARD's collective intelligence feedback loop. Receives anonymous telemetry from `bastard` CLI users and serves aggregate insights.

## Architecture

- **Cloudflare Worker** — edge-deployed, zero cold start
- **D1 SQLite** — serverless database, free tier covers 100k+ events/day
- **CORS enabled** — accessible from CLI and browser

## Routes

| Method | Path | Description |
|--------|------|-------------|
| POST | `/events` | Receive an anonymous telemetry event |
| GET | `/insights` | Return aggregate stats (cached 1h) |
| GET | `/health` | Liveness check |

## Setup

```bash
# Install deps
npm install

# Create D1 database
wrangler d1 create bastard-feedback
# Copy the database_id into wrangler.toml

# Initialize schema
npm run db:init:remote

# Deploy
npm run deploy
```

## Privacy

This API receives **zero identifiable data**:
- No file paths
- No code excerpts
- No project names
- Only: scores, pattern counts, round durations, framework adoption

Session hashes are sha256 and cannot be reversed.

## Rate limits

100 events/minute per IP. No authentication required.

## License

MIT
