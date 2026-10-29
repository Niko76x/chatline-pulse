import { timingSafeEqual } from 'node:crypto';

// The caller can trigger this one reviewed workflow, never select an account,
// repository, branch, URL, payload, credential or different workflow.
export const DISPATCH_URL = 'https://api.github.com/repos/Niko76x/chatline-pulse/actions/workflows/pulse-refresh.yml/dispatches';
export const maxDuration = 10;
const SECRET = /^[A-Za-z0-9_-]{32,128}$/;
const emptyObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
const emptyBody = value => value === undefined || value === null || value === '' || emptyObject(value);

function authorized(header, secret) {
  if (typeof header !== 'string') return false;
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/i.exec(header);
  if (!match || match[1].length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(match[1]), Buffer.from(secret));
}

export function createRefreshHandler({ env = process.env, fetcher = fetch, now = () => new Date() } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'POST'].includes(req.method)) {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
    }
    if (env.PULSE_EXTERNAL_REFRESH_ENABLED !== 'true' || env.VERCEL_ENV !== 'production')
      return res.status(503).json({ error: 'REFRESH_DISABLED' });

    const secret = env.CRON_SECRET;
    const token = env.PULSE_WORKFLOW_DISPATCH_TOKEN;
    if (typeof secret !== 'string' || !SECRET.test(secret) || typeof token !== 'string' ||
        token.length < 20 || token.length > 2048 || /\s/.test(token))
      return res.status(503).json({ error: 'REFRESH_NOT_CONFIGURED' });
    if (!authorized(req.headers?.authorization, secret))
      return res.status(401).json({ error: 'UNAUTHORIZED' });
    if (req.query !== undefined && !emptyObject(req.query) || !emptyBody(req.body))
      return res.status(400).json({ error: 'PARAMETERS_NOT_SUPPORTED' });

    try {
      const response = await fetcher(DISPATCH_URL, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'ChatLine-Pulse-Refresh',
        },
        body: JSON.stringify({ ref: 'main' }),
      });
      // Do not parse or echo upstream bodies, messages, request URLs or headers.
      // Accepted dispatch is not proof of a completed collection or new data.
      if (response.status === 204)
        return res.status(202).json({ status: 'queued', queued_at: now().toISOString(), data_refreshed: false });
      const error = [401, 403].includes(response.status) ? 'DISPATCH_ACCESS_REQUIRED'
        : response.status === 429 ? 'DISPATCH_RATE_LIMITED' : 'DISPATCH_FAILED';
      return res.status(503).json({ error });
    } catch {
      return res.status(503).json({ error: 'DISPATCH_UNAVAILABLE' });
    }
  };
}

export default createRefreshHandler();
