// api/proxy.js
// Vercel Serverless Function for HLS (m3u8) proxy
// Usage: GET /api/proxy?url=<encodedAbsoluteUrl>

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range,Origin,Accept,X-Requested-With,Content-Type,Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();

  const upstreamUrl = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
  if (!upstreamUrl) return res.status(400).send('Missing url parameter');

  // Validate URL
  let parsed;
  try {
    parsed = new URL(upstreamUrl);
  } catch (err) {
    return res.status(400).send('Invalid url parameter');
  }

  // ALLOWED_HOSTS env var: comma separated hostnames (recommended)
  const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (ALLOWED_HOSTS.length > 0 && !ALLOWED_HOSTS.includes(parsed.hostname)) {
    return res.status(403).send('Host not allowed. Configure ALLOWED_HOSTS environment variable in Vercel.');
  }

  // Optional authentication token (simple): if AUTH_TOKEN set, require header x-proxy-token or ?token=
  if (process.env.AUTH_TOKEN) {
    const token = req.headers['x-proxy-token'] || req.query.token;
    if (!token || token !== process.env.AUTH_TOKEN) {
      return res.status(401).send('Unauthorized: missing or invalid token');
    }
  }

  try {
    // Forward Range header (useful for segments), and set a User-Agent
    const fetchHeaders = {};
    if (req.headers.range) fetchHeaders.Range = req.headers.range;
    fetchHeaders['User-Agent'] = req.headers['user-agent'] || 'vercel-hls-proxy';

    const upstreamRes = await fetch(upstreamUrl, { method: 'GET', headers: fetchHeaders, redirect: 'follow' });

    if (!upstreamRes.ok && upstreamRes.status !== 206) {
      return res.status(upstreamRes.status).send(`Upstream responded ${upstreamRes.status}`);
    }

    const contentType = upstreamRes.headers.get('content-type') || '';
    const isPlaylist = contentType.includes('mpegurl') || contentType.includes('vnd.apple.mpegurl') || upstreamUrl.toLowerCase().endsWith('.m3u8');

    if (isPlaylist) {
      const text = await upstreamRes.text();

      // Build base URL that points back to this deployment
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers.host;
      const hostBase = `${proto}://${host}`;

      const rewritten = rewriteM3U8(text, upstreamUrl, hostBase);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      const cache = upstreamRes.headers.get('cache-control');
      if (cache) res.setHeader('Cache-Control', cache);
      return res.status(200).send(rewritten);
    }

    // For segments or other binary files: forward useful headers and send bytes
    const forwardHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'etag', 'last-modified'];
    forwardHeaders.forEach(h => {
      const v = upstreamRes.headers.get(h);
      if (v) res.setHeader(h, v);
    });

    res.status(upstreamRes.status);
    const buffer = Buffer.from(await upstreamRes.arrayBuffer());
    res.end(buffer);
  } catch (err) {
    console.error('Proxy error', err);
    res.status(502).send('Bad Gateway');
  }
}

/** Rewrite m3u8 playlist so each URI is made absolute and proxied via /api/proxy */
function rewriteM3U8(m3u8Text, playlistUrl, hostBase) {
  const lines = m3u8Text.split(/\r?\n/);
  const out = lines.map(line => {
    if (!line || line.startsWith('#')) return line;
    try {
      const absolute = new URL(line, playlistUrl).href;
      const proxied = `${hostBase}/api/proxy?url=${encodeURIComponent(absolute)}`;
      return proxied;
    } catch (e) {
      return line;
    }
  });
  return out.join('\n');
}
