import axios from 'axios';

const PLACES_BASE = 'https://maps.googleapis.com/maps/api/place';

// Bay Area center fallback (covers SF → San Jose corridor)
const BAY_AREA_LAT = 37.5485;
const BAY_AREA_LNG = -121.9886;
const BAY_AREA_RADIUS = 50000; // 50km covers the full Bay Area

/**
 * Extract the search intent and location hint from a user query.
 * e.g. "rainy day ramen near University Ave Palo Alto"
 *   → { intent: "rainy day ramen", locationHint: "University Ave Palo Alto" }
 * e.g. "I'm at the San Carlos Library, suggest coffee near me"
 *   → { intent: "coffee", locationHint: "San Carlos Library" }
 */
export function parseQuery(userQuery) {
  const q = userQuery.trim();

  // "I'm at X" / "I am at X" → location is X, intent is what follows suggest/want/find/need
  const iAmAt = q.match(/i(?:'m| am) at\s+(.+?)(?:,?\s+(?:suggest|find|recommend|want|need|looking for|craving)\s+(.+))?$/i);
  if (iAmAt) {
    const locationHint = iAmAt[1].replace(/,.*$/, '').trim();
    const intentPart = iAmAt[2] || q.replace(/i(?:'m| am) at\s+.+$/i, '').replace('near me', '').trim();
    return { intent: intentPart || q, locationHint };
  }

  // "X near Y" → intent=X, location=Y
  const nearMatch = q.match(/^(.+?)\s+near\s+(.+)$/i);
  if (nearMatch) {
    return { intent: nearMatch[1].trim(), locationHint: nearMatch[2].trim() };
  }

  // "X in Y" where Y looks like a location (starts with a proper noun or known pattern)
  const inMatch = q.match(/^(.+?)\s+in\s+([A-Z][a-zA-Z\s,]+|[a-z]+\s+[A-Z][a-zA-Z\s]+)$/);
  if (inMatch) {
    return { intent: inMatch[1].trim(), locationHint: inMatch[2].trim() };
  }

  // "X by Y" / "X around Y" / "X close to Y"
  const byMatch = q.match(/^(.+?)\s+(?:by|around|close to)\s+(.+)$/i);
  if (byMatch) {
    return { intent: byMatch[1].trim(), locationHint: byMatch[2].trim() };
  }

  return { intent: q, locationHint: null };
}

/**
 * Use Google Places textsearch to turn a location string into lat/lng.
 * Returns { lat, lng } or null on failure.
 */
export async function geocodeLocation(locationText) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  try {
    const res = await axios.get(`${PLACES_BASE}/textsearch/json`, {
      params: {
        query: locationText,
        key: apiKey,
        fields: 'geometry',
      },
    });
    const loc = res.data.results?.[0]?.geometry?.location;
    if (!loc) return null;
    return { lat: loc.lat, lng: loc.lng };
  } catch {
    return null;
  }
}

/**
 * Search for a place matching `intent`, biased around `lat`/`lng`.
 * Falls back to Bay Area center if no coordinates provided.
 */
export async function searchAndGetPlaceDetails(intent, lat, lng) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;

  const biasLat = lat ?? BAY_AREA_LAT;
  const biasLng = lng ?? BAY_AREA_LNG;
  const radius  = lat ? 5000 : BAY_AREA_RADIUS;

  // Text search biased to the location
  const searchRes = await axios.get(`${PLACES_BASE}/textsearch/json`, {
    params: {
      query: intent,
      location: `${biasLat},${biasLng}`,
      radius,
      key: apiKey,
    },
  });

  const results = searchRes.data.results;
  if (!results || results.length === 0) {
    throw new Error('No places found for that query.');
  }

  const topResult = results[0];
  const placeId = topResult.place_id;

  // Place Details — get reviews, photo, address
  const detailsRes = await axios.get(`${PLACES_BASE}/details/json`, {
    params: {
      place_id: placeId,
      fields: 'name,rating,formatted_address,reviews,photos,url',
      key: apiKey,
    },
  });

  const place = detailsRes.data.result;

  const reviews = (place.reviews || []).slice(0, 5).map((r) => ({
    source: 'Google',
    author: r.author_name,
    rating: r.rating,
    text: r.text,
    time: r.relative_time_description,
  }));

  let photoUrl = null;
  if (place.photos?.length > 0) {
    const ref = place.photos[0].photo_reference;
    photoUrl = `${PLACES_BASE}/photo?maxwidth=800&photoreference=${ref}&key=${apiKey}`;
  }

  return {
    name: place.name,
    rating: place.rating,
    address: place.formatted_address,
    googleUrl: place.url,
    photoUrl,
    reviews,
  };
}
