# ChatLine Pulse

A focused, read-only dashboard for the ChatLine Pilates studio test.

The dashboard separates ad delivery, link clicks, landing-page views, attributed conversion signals and independently confirmed business results. Each source retains its own observation time. Missing data is not displayed as zero. Review hints never modify ads or budgets.

## Runtime

- `public/index.html`: accessible responsive dashboard with bundled styles and client code.
- `api/data.js`: GET-only endpoint and shared scope/snapshot validation.
- `public/data/fallback.json`: verified historical fallback with its original timestamps.
- `scripts/refresh.mjs`: server-side collector for the fixed ChatLine account, dataset, campaign and adset.
- `test/`: scope, privacy, freshness, pagination and failure-handling checks.

Node.js 22 or newer is required. Run `npm test` to verify the reporting logic. Vercel serves `public` and the `/api/data` function. Credentials never belong in source code, snapshots or client responses.

## Server updates

The intended collector schedule is every 30 minutes through GitHub Actions. It must first be configured with a read-only Meta reporting token, the supported Graph API version and the prepared `pulse-data` branch. The collector publishes only validated aggregates to that branch, whose Vercel deployments are disabled. Enable the schedule only after a successful manual run and comparison with Ads Manager for the same period.

Scheduled execution can be delayed by the provider. The dashboard exposes stale data and source failures instead of claiming a fresh successful collection.

Website analytics, raw dataset signals, qualified tests and payments are independent sources. Their connection status is explicit; ad attribution is not a substitute for those sources.

## Recovery

Disable the reporting workflow or set `PULSE_SYNC_ENABLED=false` to stop collection. This does not affect ads. Vercel can restore the previous deployment. A failed collection preserves the last successful observation timestamp and values.
