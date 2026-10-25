# ChatLine Pulse

A focused, read-only dashboard for the ChatLine Pilates studio test.

The dashboard separates ad delivery, link clicks, landing-page views, attributed conversion signals and independently confirmed business results. Each source retains its own observation time. Missing data is not displayed as zero. Review hints never modify ads or budgets.

## Runtime

- `public/index.html`: responsive dashboard with bundled styles and client code.
- `api/data.js`: GET-only endpoint, fixed scope and shared snapshot validation.
- `public/data/fallback.json`: historical fallback retaining its original timestamps.
- `scripts/refresh.mjs`: server-side collector for the fixed ChatLine account, dataset, campaign and adset.
- `test/`: scope, privacy, freshness, pagination and partial-failure checks.

Node.js 22 or newer is required. Run `npm test` to verify reporting logic. Vercel serves `public` and the `/api/data` function. Credentials never belong in source code, snapshots or client responses.

## Server updates

The intended collector schedule is every 30 minutes through GitHub Actions. A manual Analytics-only run can operate independently while Meta reporting is disabled. `META_REPORTING_ENABLED` is false unless explicitly set to `true`; a disabled Meta source retains its values, status and observation times unchanged. No enabled, authenticated source means the collector fails before accessing the snapshot store. Only validated aggregates are published. Enable the schedule after a successful manual run and comparison with the relevant source for the same period.

Scheduled execution can be delayed. Source observation times and stale/error states remain visible instead of claiming a fresh successful collection.

## Independent optional sources

Raw Meta dataset counts use a separate, disabled-by-default adapter. `META_DATASET_STATS_ENABLED` must remain unset or false until permission and the actual live response are verified. It requests only standard-event counts for the fixed dataset and current UTC day. Missing events stay unknown. These counts are not unique visitors or proven payments.

Vercel Web Analytics reads exactly the two verified HeyHo Systems projects: `chatline-website` and `limitless`. The adapter never searches other projects or accepts project selection from the browser. Two separate server-only credentials are mapped by fixed site key: `VERCEL_ANALYTICS_CHATLINE_WEBSITE_TOKEN` for the website project and `VERCEL_ANALYTICS_LIMITLESS_TOKEN` for the DIY project. A missing or failed credential affects only its own source; there is no shared token, inherited credential or fallback to another project's token. Actual token creation and permissions remain separate setup actions.

The query requests project-wide production aggregates using the documented `environment eq 'production'` filter and daily grouping. The `chatline-website` figures include production aliases `chatline.app` and `mindbody-home.chatline.app`; `limitless` is shown separately with `start.chatline.app`. No unsupported hostname filter is claimed. Visitors and pageviews are shown per returned UTC day. Visitors are never summed across days or projects. Missing days are not filled with zeros. If one source fails, its last known values and observation time remain intact while independent successful sources can update. Analytics availability depends on the project's enabled instrumentation, permissions and reporting window.

Qualified studio tests, answered conversations, payments and Search Console require separate verified sources. Ad attribution is not a substitute for them.

Official references: [Vercel Web Analytics API](https://vercel.com/docs/analytics/web-analytics-api), [aggregate endpoint](https://vercel.com/docs/rest-api/web-analytics/aggregates-page-views).

## Recovery

Disable the reporting workflow or set `PULSE_SYNC_ENABLED=false` to stop collection. This does not affect ads. Vercel can restore the previous deployment. Failed reads preserve source observation timestamps and values.
