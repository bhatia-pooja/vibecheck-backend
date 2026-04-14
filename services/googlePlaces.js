import axios from 'axios';

const PLACES_BASE = 'https://maps.googleapis.com/maps/api/place';

// SF city center — much better anchor than South Bay for Bay Area searches
const BAY_AREA_LAT = 37.7749;
const BAY_AREA_LNG = -122.4194;
const BAY_AREA_RADIUS = 40000; // 40km covers the full Bay Area from SF center

// Hard radius for "near X" searches — nearbysearch enforces this strictly
const NEARBY_RADIUS = 4000; // 4km (~2.5 miles)

/**
 * Extract intent + location hint from a user query.
 */
export function parseQuery(userQuery) {
  const q = userQuery.trim();

  const iAmAt = q.match(/i(?:'m| am) at\s+(.+?)(?:,?\s+(?:suggest|find|recommend|want|need|looking for|craving)\s+(.+))?$/i);
  if (iAmAt) {
    const locationHint = iAmAt[1].replace(/,.*$/, '').trim();
    const intentPart = iAmAt[2] || q.replace(/i(?:'m| am) at\s+.+$/i, '').replace('near me', '').trim();
    return { intent: intentPart || q, locationHint };
  }

  const nearMatch = q.match(/^(.+?)\s+near\s+(.+)$/i);
  if (nearMatch) return { intent: nearMatch[1].trim(), locationHint: nearMatch[2].trim() };

  const inMatch = q.match(/^(.+?)\s+in\s+([A-Z][a-zA-Z\s,]+|[a-z]+\s+[A-Z][a-zA-Z\s]+)$/);
  if (inMatch) return { intent: inMatch[1].trim(), locationHint: inMatch[2].trim() };

  const byMatch = q.match(/^(.+?)\s+(?:by|around|close to)\s+(.+)$/i);
  if (byMatch) return { intent: byMatch[1].trim(), locationHint: byMatch[2].trim() };

  return { intent: q, locationHint: null };
}

/**
 * Geocode a location string → { lat, lng }.
 * Appends "Bay Area CA" for short/ambiguous hints so "university ave"
 * doesn't geocode to a random street in Ohio.
 */
export async function geocodeLocation(locationText) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;

  // Short hints (≤3 words, no city name) are ambiguous — anchor to Bay Area
  const words = locationText.trim().split(/\s+/);
  const hasCityName = /\b(san francisco|sf|palo alto|san jose|mountain view|oakland|berkeley|marin|fremont|sunnyvale|cupertino|santa clara|hayward|burlingame|san mateo|san carlos|redwood city|menlo park|east bay|south bay|north bay|peninsula|silicon valley|downtown)\b/i.test(locationText);
  const geocodeQuery = (words.length <= 3 && !hasCityName)
    ? `${locationText} Bay Area CA`
    : locationText;

  try {
    const res = await axios.get(`${PLACES_BASE}/textsearch/json`, {
      params: { query: geocodeQuery, key: apiKey, fields: 'geometry' },
    });
    const loc = res.data.results?.[0]?.geometry?.location;
    if (!loc) return null;
    return { lat: loc.lat, lng: loc.lng };
  } catch {
    return null;
  }
}

/**
 * Haversine distance between two lat/lng points, in km.
 */
function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Nearby Search — hard radius, only returns places within the circle.
 * Used when we have real coordinates (user specified a location).
 */
async function nearbySearch(keyword, lat, lng) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const res = await axios.get(`${PLACES_BASE}/nearbysearch/json`, {
    params: {
      keyword,
      location: `${lat},${lng}`,
      radius: NEARBY_RADIUS,
      rankby: 'prominence',
      key: apiKey,
    },
  });
  return res.data.results || [];
}

/**
 * Text Search — bias toward location, wider coverage.
 * Used as fallback or when no precise coordinates available.
 */
async function textSearch(query, lat, lng, radius) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const params = {
    query,
    key: apiKey,
    location: `${lat},${lng}`,
    radius,
  };
  const res = await axios.get(`${PLACES_BASE}/textsearch/json`, { params });
  return res.data.results || [];
}

/**
 * Get full place details (reviews, photo, address) for a place_id.
 */
async function getPlaceDetails(placeId) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const res = await axios.get(`${PLACES_BASE}/details/json`, {
    params: {
      place_id: placeId,
      fields: 'name,rating,formatted_address,reviews,photos,url,geometry',
      key: apiKey,
    },
  });
  return res.data.result;
}

/**
 * Search for a place matching `intent`, biased around `lat`/`lng`.
 *
 * Strategy:
 * 1. If coordinates provided → Nearby Search (hard radius, 4km). If no results → widen to text search.
 * 2. Validate the top result is actually close to target coords. If way off → retry with location appended.
 * 3. Fallback to Bay Area center (SF) if no coords at all.
 */
export async function searchAndGetPlaceDetails(intent, lat, lng) {
  const biasLat = lat ?? BAY_AREA_LAT;
  const biasLng = lng ?? BAY_AREA_LNG;

  let results = [];

  if (lat && lng) {
    // Try hard-radius nearby search first
    results = await nearbySearch(intent, lat, lng);

    // If nothing within 4km, widen to 15km text search
    if (results.length === 0) {
      console.log(`[places] no nearby results within ${NEARBY_RADIUS}m, widening to 15km`);
      results = await textSearch(intent, lat, lng, 15000);
    }
  } else {
    // No coords — use Bay Area wide text search
    results = await textSearch(intent, biasLat, biasLng, BAY_AREA_RADIUS);
  }

  if (!results || results.length === 0) {
    throw new Error('No places found for that query.');
  }

  // Validate top result isn't way off from target
  let topResult = results[0];
  if (lat && lng) {
    const resultLat = topResult.geometry?.location?.lat;
    const resultLng = topResult.geometry?.location?.lng;
    if (resultLat && resultLng) {
      const km = distanceKm(lat, lng, resultLat, resultLng);
      console.log(`[places] "${topResult.name}" is ${km.toFixed(1)}km from target`);

      // If top result is more than 20km away, try next candidates closer to target
      if (km > 20) {
        console.log(`[places] too far — scanning other results`);
        const closer = results.find((r) => {
          const rLat = r.geometry?.location?.lat;
          const rLng = r.geometry?.location?.lng;
          return rLat && rLng && distanceKm(lat, lng, rLat, rLng) <= 20;
        });
        if (closer) {
          console.log(`[places] found closer result: "${closer.name}"`);
          topResult = closer;
        }
      }
    }
  }

  const place = await getPlaceDetails(topResult.place_id);

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
    photoUrl = `${PLACES_BASE}/photo?maxwidth=800&photoreference=${ref}&key=${process.env.GOOGLE_PLACES_API_KEY}`;
  }

  return {
    name: place.name,
    rating: place.rating,
    address: place.formatted_address,
    googleUrl: place.url,
    photoUrl,
    reviews,
    lat: place.geometry?.location?.lat,
    lng: place.geometry?.location?.lng,
  };
}
