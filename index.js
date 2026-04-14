import dotenv from 'dotenv';
dotenv.config({ override: true });
import express from 'express';
import cors from 'cors';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { searchTopPlaces, searchAndGetPlaceDetails, parseQuery, geocodeLocation } from './services/googlePlaces.js';
import { getRedditReviews, getRedditForVibe } from './services/reddit.js';
import { synthesizeWithPepper } from './services/claude.js';
import { textToSpeech } from './services/elevenlabs.js';

const app = express();
app.use(cors());
app.use(express.json());

// ── Beta quota config ────────────────────────────────────────────────────────
const QUOTA_FILE  = './data/quotas.json';
const LOG_FILE    = './data/querylog.json';
const MAX_USERS   = parseInt(process.env.MAX_USERS            || '100');
const MAX_QUERIES = parseInt(process.env.MAX_QUERIES_PER_USER || '2');
const ADMIN_KEY   = process.env.ADMIN_KEY || '';

mkdirSync('./data', { recursive: true });

// Load persisted quotas on startup
let quotas = { users: {} };
try { quotas = JSON.parse(readFileSync(QUOTA_FILE, 'utf-8')); } catch { /* first run */ }

// Load persisted query log on startup
let queryLog = [];
try { queryLog = JSON.parse(readFileSync(LOG_FILE, 'utf-8')); } catch { /* first run */ }

function hashIP(ip) {
  return createHash('sha256').update(ip + 'vibecheck-salt').digest('hex').slice(0, 16);
}

function saveQuotas() {
  writeFileSync(QUOTA_FILE, JSON.stringify(quotas, null, 2));
}

function appendLog(entry) {
  queryLog.push(entry);
  // Keep last 500 entries in memory + persist
  if (queryLog.length > 500) queryLog = queryLog.slice(-500);
  writeFileSync(LOG_FILE, JSON.stringify(queryLog, null, 2));
}

function checkAndRecordQuota(req) {
  // Admin bypass — unlimited queries
  if (req.headers['x-admin-key'] === ADMIN_KEY) {
    return { allowed: true, admin: true };
  }

  const rawIP = req.headers['x-forwarded-for']?.split(',')[0].trim()
    || req.socket.remoteAddress;
  const id = hashIP(rawIP);
  const isNewUser = !quotas.users[id];
  const used = quotas.users[id]?.count || 0;

  if (isNewUser && Object.keys(quotas.users).length >= MAX_USERS) {
    return { allowed: false, reason: 'beta_full', id };
  }
  if (used >= MAX_QUERIES) {
    return { allowed: false, reason: 'quota_exceeded', used, max: MAX_QUERIES, id };
  }

  quotas.users[id] = { count: used + 1, lastSeen: new Date().toISOString() };
  saveQuotas();
  return { allowed: true, used: used + 1, max: MAX_QUERIES, id };
}

// ── Result cache ─────────────────────────────────────────────────────────────
const resultCache = new Map();
const RESULT_TTL_MS = 2 * 60 * 60 * 1000;

// ── Discovery helpers ─────────────────────────────────────────────────────────

function isDiscoveryQuery(intent) {
  if (/\b[A-Z][a-z]{2,}(?:'s)?\s+(?:Coffee|Cafe|Café|Bar|Restaurant|Kitchen|Ramen|Sushi|Bakery|Grill|Pizzeria|Brewery|Lounge|Bistro|Burger|Tacos?|Pizza|Noodle|Dumpling|Boba|Tea|House|Room|Shop|Market)\b/.test(intent)) {
    return false;
  }
  if (/^[A-Z][a-z]{2,}(?:'s)?$/.test(intent.trim())) return false;
  return true;
}

/**
 * Extract the top N place names mentioned across Reddit comments.
 * Names with a business-type signal (ramen, cafe, etc.) score higher.
 * Returns an array of names sorted by mention frequency.
 */
function extractTopMentionedPlaces(comments, count = 4) {
  const text = comments.map((c) => c.text).join('\n');
  const namePattern = /\b(?:[A-Z][a-z']{1,}(?:\s+(?:&\s+)?(?:the\s+)?[A-Z][a-z']{1,}){1,4})\b/g;
  const matches = text.match(namePattern) || [];

  const skipSet = new Set([
    'Bay Area', 'San Francisco', 'East Bay', 'South Bay', 'North Bay', 'Silicon Valley',
    'Palo Alto', 'San Jose', 'Mountain View', 'Menlo Park', 'Redwood City', 'San Carlos',
    'San Mateo', 'Burlingame', 'Santa Clara', 'Oakland', 'Berkeley', 'Marin', 'Fremont',
    'Sunnyvale', 'Cupertino', 'Los Altos', 'Los Gatos', 'Saratoga', 'Campbell',
    'Half Moon', 'Half Moon Bay', 'Foster City', 'Daly City', 'South San',
    'Google Maps', 'Yelp Reviews', 'Reddit Thread', 'New York', 'Los Angeles',
    'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December',
    'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
    'Hidden Villa',
  ]);

  const bizSignal = /\b(coffee|cafe|café|restaurant|bar|ramen|sushi|kitchen|bakery|bistro|grill|pizza|boba|brewery|diner|eatery|lounge|pub|taqueria|market|shop|house|room|creamery|roastery|cantina|trattoria|noodle|dumpling|burger|tacos?|bagel|sandwich|poke|thai|indian|dim sum)\b/i;

  const counts = {};
  for (const m of matches) {
    if (skipSet.has(m) || m.length < 5) continue;
    counts[m] = (counts[m] || 0) + (bizSignal.test(m) ? 2 : 1);
  }

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([name]) => name);
}

// ── Admin dashboard ───────────────────────────────────────────────────────────

function adminAuth(req, res, next) {
  if (!ADMIN_KEY) return res.status(503).send('Set ADMIN_KEY in .env to enable the dashboard.');
  if (req.query.key !== ADMIN_KEY) return res.status(401).send('Invalid key.');
  next();
}

app.get('/admin', adminAuth, (req, res) => {
  const totalUsers   = Object.keys(quotas.users).length;
  const totalQueries = Object.values(quotas.users).reduce((s, u) => s + u.count, 0);
  const capacityPct  = Math.round((totalUsers / MAX_USERS) * 100);
  const queryPct     = Math.round((totalQueries / (MAX_USERS * MAX_QUERIES)) * 100);

  // Bucket users by how many queries they've used
  const buckets = {};
  for (let i = 0; i <= MAX_QUERIES; i++) buckets[i] = 0;
  for (const u of Object.values(quotas.users)) {
    buckets[Math.min(u.count, MAX_QUERIES)] = (buckets[Math.min(u.count, MAX_QUERIES)] || 0) + 1;
  }

  // Recent log — last 30 entries, newest first
  const recent = [...queryLog].reverse().slice(0, 30);

  const bar = (pct, color) =>
    `<div style="background:#f0ebe3;border-radius:8px;overflow:hidden;height:10px;width:100%">
       <div style="background:${color};width:${pct}%;height:100%;border-radius:8px;transition:width .3s"></div>
     </div>`;

  const rowColor = (status) =>
    status === 'cached' ? '#f0fdf4' : status === 'error' ? '#fff0f0' : '#fff';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>🌶️ Vibe Check — Admin</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #faf7f2; color: #1c0f09; padding: 24px 20px; max-width: 860px; margin: 0 auto; }
    h1  { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
    .sub { font-size: 13px; color: #888; margin-bottom: 28px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 28px; }
    .card { background: #fff; border-radius: 12px; padding: 18px 20px;
            box-shadow: 0 2px 12px rgba(0,0,0,.06); }
    .card-label { font-size: 12px; color: #888; font-weight: 600; text-transform: uppercase;
                  letter-spacing: .5px; margin-bottom: 6px; }
    .card-value { font-size: 28px; font-weight: 700; margin-bottom: 10px; }
    .card-value.warn { color: #e85d3a; }
    .section-title { font-size: 15px; font-weight: 700; margin-bottom: 12px; }
    .buckets { display: flex; gap: 12px; margin-bottom: 28px; flex-wrap: wrap; }
    .bucket  { background: #fff; border-radius: 10px; padding: 14px 18px;
               box-shadow: 0 1px 6px rgba(0,0,0,.06); text-align: center; flex: 1; min-width: 80px; }
    .bucket-n { font-size: 22px; font-weight: 700; }
    .bucket-l { font-size: 12px; color: #888; margin-top: 2px; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 12px;
            overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,.06); font-size: 13px; }
    th { background: #faf7f2; padding: 10px 14px; text-align: left; font-size: 11px;
         font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: #888; }
    td { padding: 10px 14px; border-top: 1px solid #f5f0ea; }
    tr:hover td { background: #fffbf7; }
    .tag { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: 11px;
           font-weight: 600; }
    .tag-ok     { background: #e8f5e9; color: #2e7d32; }
    .tag-cached { background: #e3f2fd; color: #1565c0; }
    .tag-error  { background: #fce4ec; color: #c62828; }
    .tag-disc   { background: #fff3e0; color: #e65100; }
    .tag-spec   { background: #f3e5f5; color: #6a1b9a; }
    .refresh { float: right; font-size: 12px; color: #aaa; }
  </style>
  <meta http-equiv="refresh" content="30">
</head>
<body>
  <h1>🌶️ Vibe Check — Admin</h1>
  <p class="sub">Auto-refreshes every 30s &nbsp;·&nbsp; <span class="refresh">key hidden in URL</span></p>

  <div class="grid">
    <div class="card">
      <div class="card-label">Testers</div>
      <div class="card-value ${capacityPct >= 90 ? 'warn' : ''}">${totalUsers} / ${MAX_USERS}</div>
      ${bar(capacityPct, capacityPct >= 90 ? '#e85d3a' : '#4caf50')}
    </div>
    <div class="card">
      <div class="card-label">Total Queries</div>
      <div class="card-value ${queryPct >= 90 ? 'warn' : ''}">${totalQueries} / ${MAX_USERS * MAX_QUERIES}</div>
      ${bar(queryPct, queryPct >= 90 ? '#e85d3a' : '#2196f3')}
    </div>
    <div class="card">
      <div class="card-label">Limit / Person</div>
      <div class="card-value">${MAX_QUERIES}</div>
      <div style="font-size:12px;color:#888">lifetime queries</div>
    </div>
    <div class="card">
      <div class="card-label">Slots Left</div>
      <div class="card-value ${MAX_USERS - totalUsers <= 10 ? 'warn' : ''}">${MAX_USERS - totalUsers}</div>
      <div style="font-size:12px;color:#888">new testers</div>
    </div>
  </div>

  <p class="section-title">Query usage per tester</p>
  <div class="buckets">
    ${Object.entries(buckets).map(([n, count]) => `
      <div class="bucket">
        <div class="bucket-n">${count}</div>
        <div class="bucket-l">${n === '0' ? 'joined, 0 used' : n === String(MAX_QUERIES) ? `used ${n} (maxed)` : `used ${n}`}</div>
      </div>`).join('')}
  </div>

  <p class="section-title">Recent activity (last 30)</p>
  <table>
    <thead>
      <tr>
        <th>Time</th>
        <th>Query</th>
        <th>Pepper recommended</th>
        <th>Reddit</th>
        <th>ms</th>
        <th>Status</th>
        <th>Flow</th>
      </tr>
    </thead>
    <tbody>
      ${recent.map(e => `
      <tr style="background:${rowColor(e.status)}">
        <td style="white-space:nowrap;color:#888">${new Date(e.ts).toLocaleTimeString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })}</td>
        <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${e.query.replace(/"/g,'&quot;')}">${e.query}</td>
        <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${e.place || '—'}</td>
        <td style="color:#888">${e.redditCount ?? '—'}</td>
        <td style="color:#888">${e.durationMs ?? '—'}</td>
        <td><span class="tag tag-${e.status}">${e.status}</span></td>
        <td><span class="tag tag-${e.flow === 'discovery' ? 'disc' : 'spec'}">${e.flow || '—'}</span></td>
      </tr>`).join('')}
    </tbody>
  </table>
</body>
</html>`;

  res.send(html);
});

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/vibe-check
app.post('/api/vibe-check', async (req, res) => {
  const { query } = req.body;
  if (!query || !query.trim()) {
    return res.status(400).json({ error: 'Query is required.' });
  }

  const quota = checkAndRecordQuota(req);
  if (!quota.allowed) {
    const msg = quota.reason === 'beta_full'
      ? "Pepper's beta is currently full — follow along for updates when more spots open up!"
      : "You've used both your beta queries — thanks for testing! More spots coming soon.";
    appendLog({ ts: new Date().toISOString(), query, status: quota.reason, userId: quota.id });
    return res.status(429).json({ error: msg, reason: quota.reason });
  }

  const cacheKey = query.toLowerCase().trim();
  const cached = resultCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < RESULT_TTL_MS) {
    console.log(`[cache] hit for: "${cacheKey}"`);
    appendLog({ ts: new Date().toISOString(), query, status: 'cached',
                place: cached.data.places?.[0]?.name, userId: quota.id });
    return res.json(cached.data);
  }

  const t0 = Date.now();
  let logEntry = { ts: new Date().toISOString(), query, status: 'error', userId: quota.id };

  try {
    const { intent, locationHint } = parseQuery(query);

    let lat, lng;
    if (locationHint) {
      const coords = await geocodeLocation(locationHint);
      if (coords) ({ lat, lng } = coords);
    }

    let candidatePlaces, redditComments, flow;
    const vibeSearchTerms = `${intent}${locationHint ? ` ${locationHint}` : ' bay area'}`;

    if (isDiscoveryQuery(intent)) {
      flow = 'discovery';
      console.log(`[discovery] Reddit-first for: "${vibeSearchTerms}"`);
      const vibeThreads = await getRedditForVibe(vibeSearchTerms);
      const redditNames = extractTopMentionedPlaces(vibeThreads, 4);
      console.log(`[discovery] Reddit mentioned: ${redditNames.join(', ') || '(none)'}`);

      if (redditNames.length > 0) {
        // Source candidates from Reddit — enrich each with Google structured data.
        // This is the differentiator: pool comes from community recommendations, not Google ranking.
        const lookups = redditNames.map((name) =>
          searchTopPlaces(`${name} ${locationHint || ''}`.trim(), lat, lng, 1)
            .then((r) => r[0] || null)
            .catch(() => null)
        );
        const resolved = await Promise.all(lookups);
        // Deduplicate by normalized name in case Google resolves two Reddit names to the same place
        const seen = new Set();
        candidatePlaces = resolved.filter((p) => {
          if (!p) return false;
          const key = p.name.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        console.log(`[discovery] Reddit-sourced candidates: ${candidatePlaces.map((p) => p.name).join(', ')}`);
      }

      // Fallback: Reddit found no named places → Google search on the intent
      if (!candidatePlaces || candidatePlaces.length === 0) {
        console.log('[discovery] no Reddit names found, falling back to Google search');
        candidatePlaces = await searchTopPlaces(intent, lat, lng, 3);
      }

      // Pass the full vibe threads to Pepper as Reddit context — they already contain
      // the specific mentions and WHY each place was recommended, which is the signal Pepper needs.
      redditComments = vibeThreads.slice(0, 20);
    } else {
      flow = 'specific';
      console.log(`[specific] Google-first for: "${intent}"`);
      candidatePlaces = await searchTopPlaces(intent, lat, lng, 1);
      redditComments = await getRedditReviews(candidatePlaces[0].name);
    }

    const pepperResponse = await synthesizeWithPepper(query, candidatePlaces, redditComments);

    // Match Pepper's chosen place name back to our candidates to get the right photo/URL
    const enrichedPlaces = pepperResponse.places.map((p) => {
      const match = candidatePlaces.find(
        (c) => c.name.toLowerCase() === p.name?.toLowerCase()
      ) || candidatePlaces[0];
      return {
        ...p,
        photoUrl: match.photoUrl,
        googleUrl: match.googleUrl,
        sources: ['google', ...(redditComments.length > 0 ? ['reddit'] : [])],
      };
    });

    const result = {
      places: enrichedPlaces,
      vibe_check_script: pepperResponse.vibe_check_script,
      query_type: pepperResponse.query_type,
    };

    resultCache.set(cacheKey, { data: result, ts: Date.now() });

    logEntry = {
      ts: new Date().toISOString(),
      query,
      status: 'ok',
      flow,
      place: candidatePlaces[0]?.name,
      redditCount: redditComments.length,
      durationMs: Date.now() - t0,
      userId: quota.id,
    };

    return res.json(result);
  } catch (err) {
    console.error('Vibe check error:', err);
    logEntry.durationMs = Date.now() - t0;
    logEntry.error = err.message;
    return res.status(500).json({ error: err.message || 'Something went wrong.' });
  } finally {
    appendLog(logEntry);
  }
});

// POST /api/tts
app.post('/api/tts', async (req, res) => {
  const { script } = req.body;
  if (!script) return res.status(400).json({ error: 'Script is required.' });

  try {
    const audioBuffer = await textToSpeech(script);
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', audioBuffer.length);
    res.send(audioBuffer);
  } catch (err) {
    console.error('TTS error:', err);
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Vibe Check backend running on http://localhost:${PORT}`);
  console.log(`Beta limits: ${MAX_QUERIES} queries/user · ${MAX_USERS} users max`);
  console.log(`Testers so far: ${Object.keys(quotas.users).length}/${MAX_USERS}`);
  if (ADMIN_KEY) console.log(`Admin: http://localhost:${PORT}/admin?key=${ADMIN_KEY}`);
  else console.warn('⚠️  No ADMIN_KEY set — dashboard disabled');
});
