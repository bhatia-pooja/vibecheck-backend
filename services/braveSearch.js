import axios from 'axios';

const BRAVE_BASE = 'https://api.search.brave.com/res/v1/web/search';

const cache = new Map();
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

// Vibe words users say → Reddit-native language people actually write in threads
const VIBE_MAP = [
  [/\b(solo|alone|by myself|just me)\b/i,           'solo dining eating alone'],
  [/\b(date night|romantic|intimate|anniversary)\b/i, 'romantic date night'],
  [/\b(cozy|cosy|warm|snug)\b/i,                    'cozy atmosphere'],
  [/\b(hidden gem|underrated|secret|off the beaten)\b/i, 'underrated hidden gem'],
  [/\b(study|laptop|wifi|work|remote)\b/i,           'laptop friendly cafe wifi'],
  [/\b(group|friends|hangout|large party|squad)\b/i, 'group hangout friends'],
  [/\b(late night|midnight|after hours|after 10)\b/i,'late night open late'],
  [/\b(cheap|affordable|budget|inexpensive)\b/i,     'affordable cheap budget'],
  [/\b(fancy|upscale|fine dining|special occasion)\b/i, 'upscale fine dining'],
  [/\b(brunch)\b/i,                                  'brunch weekend'],
  [/\b(hungover|hangover|recovery)\b/i,              'hangover cure comfort food'],
  [/\b(boba|bubble tea)\b/i,                         'boba bubble tea'],
  [/\b(ramen)\b/i,                                   'ramen noodles'],
  [/\b(coffee|cafe|espresso)\b/i,                    'coffee cafe espresso'],
];

function translateVibe(query) {
  for (const [pattern, terms] of VIBE_MAP) {
    if (pattern.test(query)) return terms;
  }
  return '';
}

// Pick subreddits based on location hint
function getSubreddits(locationHint) {
  const loc = (locationHint || '').toLowerCase();
  if (/\b(san francisco|sf|soma|mission|castro|hayes|marina|richmond|sunset|tenderloin|noe|pac heights|financial district)\b/.test(loc))
    return ['r/AskSF', 'r/sanfrancisco'];
  if (/\b(oakland|east bay|berkeley|alameda|temescal|piedmont|emeryville)\b/.test(loc))
    return ['r/eastbay', 'r/oakland'];
  if (/\b(palo alto|mountain view|sunnyvale|san jose|cupertino|santa clara|los altos|campbell|los gatos|saratoga)\b/.test(loc))
    return ['r/SiliconValley', 'r/bayarea'];
  if (/\b(san mateo|burlingame|redwood city|menlo park|san carlos|foster city|peninsula)\b/.test(loc))
    return ['r/bayarea'];
  if (/\b(marin|sausalito|mill valley|tiburon|north bay)\b/.test(loc))
    return ['r/bayarea'];
  return ['r/bayarea', 'r/AskSF'];
}

async function braveSearch(query) {
  const cached = cache.get(query);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    console.log(`[brave] cache hit: "${query}"`);
    return cached.data;
  }

  console.log(`[brave] searching: "${query.slice(0, 70)}"`);
  const res = await axios.get(BRAVE_BASE, {
    headers: {
      'Accept': 'application/json',
      'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY,
    },
    params: { q: query, count: 10 },
  });

  const results = res.data?.web?.results || [];
  cache.set(query, { data: results, ts: Date.now() });
  return results;
}

function resultsToComments(results) {
  const comments = [];
  for (const r of results) {
    if (!r.url?.includes('reddit.com')) continue;
    const text = [r.title, r.description].filter(Boolean).join('. ');
    if (text.length < 30) continue;
    const subMatch = r.url.match(/reddit\.com\/r\/([^/]+)/);
    const source = subMatch ? `r/${subMatch[1]}` : 'reddit';
    comments.push({ source, type: 'search_snippet', text, url: r.url, title: r.title });
  }
  return comments;
}

/**
 * Search Reddit via Brave for vibe/discovery queries.
 * 3 strategic query variants run in parallel:
 *   1. Subreddit-targeted + "recommendations" framing
 *   2. Vibe-translated to Reddit-native language
 *   3. Broad Bay Area fallback
 */
export async function searchRedditForVibe(intent, locationHint, originalQuery) {
  const loc = locationHint || 'Bay Area';
  const subreddits = getSubreddits(locationHint);
  const primarySub = subreddits[0];
  const vibeTerms = translateVibe(originalQuery || intent);

  const queries = [
    // Best signal: subreddit-targeted recommendation thread (subreddit as keyword, not site: subpath)
    `site:reddit.com ${primarySub} ${intent} ${loc} recommendations`,
    // Vibe-translated: Reddit-native language
    vibeTerms
      ? `site:reddit.com ${intent} ${vibeTerms} ${loc}`
      : `site:reddit.com best ${intent} ${loc}`,
    // Broad fallback — bayarea subreddit as keyword
    `site:reddit.com bayarea ${intent} ${loc}`,
  ];

  const allResults = await Promise.all(
    queries.map((q) => braveSearch(q).catch((e) => {
      console.error(`[brave] error for "${q.slice(0, 60)}":`, e.response?.status, e.response?.data?.message || e.message);
      return [];
    }))
  );

  // Merge + deduplicate by URL
  const seen = new Set();
  const comments = [];
  for (const results of allResults) {
    for (const c of resultsToComments(results)) {
      if (seen.has(c.text)) continue;
      seen.add(c.text);
      comments.push(c);
    }
  }

  console.log(`[brave] vibe search returned ${comments.length} Reddit snippets`);
  return comments.slice(0, 25);
}

/**
 * Search Reddit via Brave for a specific named place.
 * Used for specific (non-discovery) queries and place review enrichment.
 */
export async function searchRedditForPlace(placeName) {
  const queries = [
    `site:reddit.com "${placeName}" recommendation`,
    `site:reddit.com "${placeName}" review bay area`,
  ];

  const allResults = await Promise.all(
    queries.map((q) => braveSearch(q).catch(() => []))
  );

  const seen = new Set();
  const comments = [];
  for (const results of allResults) {
    for (const c of resultsToComments(results)) {
      if (seen.has(c.text)) continue;
      seen.add(c.text);
      comments.push(c);
    }
  }

  console.log(`[brave] place search for "${placeName}" returned ${comments.length} snippets`);
  return comments.slice(0, 15);
}
