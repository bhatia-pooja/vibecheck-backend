import fetch from 'node-fetch';

// Expanded subreddit list — AskSF is great for "best X in SF" threads
const SUBREDDITS_GENERAL = ['bayarea', 'sanfrancisco', 'AskSF', 'SiliconValley', 'eastbay'];
const SUBREDDITS_SPECIFIC = ['bayarea', 'sanfrancisco', 'AskSF', 'SiliconValley', 'PaloAlto', 'oakland', 'eastbay'];
const USER_AGENT = 'VibeCheck/1.0 (local app)';

const cache = new Map();
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

async function fetchJSON(url) {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) return null;
  const data = await res.json();
  cache.set(url, { data, ts: Date.now() });
  return data;
}

/**
 * Search a subreddit for a query string.
 * sort=top + t=year surfaces the most-upvoted relevant posts from the past year.
 */
async function searchSubreddit(subreddit, query, limit = 3) {
  const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&limit=${limit}&sort=top&t=year`;
  const data = await fetchJSON(url);
  if (!data) return [];
  return data?.data?.children?.map((c) => c.data) || [];
}

async function getPostComments(postId) {
  const url = `https://www.reddit.com/comments/${postId}.json?limit=8&sort=top`;
  const data = await fetchJSON(url);
  if (!data || !Array.isArray(data)) return [];
  const comments = data[1]?.data?.children || [];
  return comments
    .filter((c) => c.kind === 't1' && c.data.score > 2)
    .slice(0, 8)
    .map((c) => c.data.body);
}

/**
 * Look up Reddit reviews for a SPECIFIC named place.
 * Searches with the place name + a few signal words to find relevant threads.
 */
export async function getRedditReviews(placeName) {
  // Try multiple keyword variants to find threads that actually discuss this place
  const queries = [
    placeName,
    `${placeName} review`,
    `${placeName} worth it`,
  ];

  const comments = [];
  const seenPostIds = new Set();

  for (const query of queries) {
    if (comments.length >= 15) break;

    const subredditResults = await Promise.all(
      SUBREDDITS_SPECIFIC.map((sub) => searchSubreddit(sub, query, 2))
    );

    for (let i = 0; i < SUBREDDITS_SPECIFIC.length; i++) {
      const sub = SUBREDDITS_SPECIFIC[i];
      const posts = subredditResults[i];

      for (const post of posts) {
        if (!post.id || seenPostIds.has(post.id)) continue;
        seenPostIds.add(post.id);

        // Only include posts that actually mention the place name
        const relevantTitle = post.title.toLowerCase().includes(placeName.split(' ')[0].toLowerCase());
        if (!relevantTitle && query === placeName) continue;

        if (post.selftext && post.selftext.length > 30) {
          comments.push({
            source: `r/${sub}`,
            type: 'post',
            text: `${post.title}. ${post.selftext}`.slice(0, 500),
          });
        }

        const postComments = await getPostComments(post.id);
        postComments.forEach((text) => {
          comments.push({ source: `r/${sub}`, type: 'comment', text });
        });

        if (comments.length >= 15) break;
      }
    }
  }

  return comments.slice(0, 20);
}

/**
 * Search Reddit for a VIBE/DISCOVERY query — used before we know the place name.
 * e.g. "hidden gems peninsula", "cozy coffee study spot south bay"
 * Returns threads + comments so we can extract mentioned place names.
 */
export async function getRedditForVibe(vibeQuery) {
  // Build multiple search variants to maximize thread coverage
  const queries = [
    vibeQuery,
    `${vibeQuery} recommendations`,
    `best ${vibeQuery}`,
  ].filter((q, i, arr) => arr.indexOf(q) === i).slice(0, 3); // dedupe, max 3

  const comments = [];
  const seenPostIds = new Set();

  for (const query of queries) {
    if (comments.length >= 20) break;

    const subredditResults = await Promise.all(
      SUBREDDITS_GENERAL.map((sub) => searchSubreddit(sub, query, 3))
    );

    for (let i = 0; i < SUBREDDITS_GENERAL.length; i++) {
      const sub = SUBREDDITS_GENERAL[i];
      const posts = subredditResults[i];

      for (const post of posts.slice(0, 2)) {
        if (!post.id || seenPostIds.has(post.id)) continue;
        seenPostIds.add(post.id);

        if (post.selftext && post.selftext.length > 30) {
          comments.push({
            source: `r/${sub}`,
            type: 'post',
            text: `${post.title}. ${post.selftext}`.slice(0, 600),
          });
        }

        const postComments = await getPostComments(post.id);
        postComments.forEach((text) => {
          comments.push({ source: `r/${sub}`, type: 'comment', text });
        });

        if (comments.length >= 20) break;
      }
    }
  }

  return comments.slice(0, 25);
}
