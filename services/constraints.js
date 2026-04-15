/**
 * Extract structured constraints from a natural language query.
 * These are passed to Google (for radius/type filtering) and Pepper
 * (so she explicitly addresses each one in her recommendation).
 */
export function extractConstraints(query) {
  const q = query.toLowerCase();
  const constraints = [];

  // ── Distance ──────────────────────────────────────────────────────────────
  if (/\bwalking distance\b|\bwalkable\b|\bwalk there\b|\bon foot\b|\bwalk from\b/.test(q)) {
    constraints.push({ type: 'distance', label: 'walking distance', radiusM: 800 });
  } else if (/\b(5|five)\s*min(ute)?\s*walk\b/.test(q)) {
    constraints.push({ type: 'distance', label: '5-min walk', radiusM: 400 });
  } else if (/\b(10|ten)\s*min(ute)?\s*walk\b/.test(q)) {
    constraints.push({ type: 'distance', label: '10-min walk', radiusM: 800 });
  } else if (/\b(15|fifteen)\s*min(ute)?\s*walk\b/.test(q)) {
    constraints.push({ type: 'distance', label: '15-min walk', radiusM: 1200 });
  } else if (/\b(5|five)\s*min(ute)?\s*drive\b/.test(q)) {
    constraints.push({ type: 'distance', label: '5-min drive', radiusM: 4000 });
  } else if (/\b(10|ten)\s*min(ute)?\s*drive\b/.test(q)) {
    constraints.push({ type: 'distance', label: '10-min drive', radiusM: 8000 });
  } else if (/\bnearby\b|\bclose by\b|\bvery close\b/.test(q)) {
    constraints.push({ type: 'distance', label: 'very close', radiusM: 1500 });
  }

  // ── Hours ─────────────────────────────────────────────────────────────────
  if (/\bopen late\b|\blate night\b|\bafter (10|11|midnight)\b|\bopen at (10|11)\s*pm\b/.test(q)) {
    constraints.push({ type: 'hours', label: 'open late' });
  }
  if (/\bright now\b|\bopen now\b/.test(q)) {
    constraints.push({ type: 'hours', label: 'open right now' });
  }
  if (/\beach\b|\bbefore noon\b|\bmorning\b|\bbreakfast\b/.test(q)) {
    constraints.push({ type: 'hours', label: 'morning hours' });
  }

  // ── Features ──────────────────────────────────────────────────────────────
  if (/\bgood wifi\b|\bfast wifi\b|\bwifi\b|\bwi-fi\b|\bwireless\b/.test(q)) {
    constraints.push({ type: 'feature', label: 'good wifi' });
  }
  if (/\boutlets?\b|\bpower outlets?\b|\bcharging\b/.test(q)) {
    constraints.push({ type: 'feature', label: 'power outlets' });
  }
  if (/\bquiet\b|\bpeaceful\b|\blow.key\b|\bcalm\b/.test(q)) {
    constraints.push({ type: 'atmosphere', label: 'quiet atmosphere' });
  }
  if (/\blively\b|\bbuzzy\b|\benergetic\b|\bvibrant\b/.test(q)) {
    constraints.push({ type: 'atmosphere', label: 'lively atmosphere' });
  }
  if (/\bdog.friendly\b|\bdogs? (ok|allowed|welcome)\b|\bpet.friendly\b/.test(q)) {
    constraints.push({ type: 'feature', label: 'dog friendly' });
  }
  if (/\boutdoor\b|\bpatio\b|\bterrace\b|\boutside seating\b|\balfresco\b/.test(q)) {
    constraints.push({ type: 'feature', label: 'outdoor seating' });
  }
  if (/\bparking\b|\bfree parking\b|\bstreet parking\b/.test(q)) {
    constraints.push({ type: 'feature', label: 'parking available' });
  }
  if (/\bstud(y|ying)\b|\bwork remotely\b|\blaptop.friendly\b|\bwork from\b/.test(q)) {
    constraints.push({ type: 'feature', label: 'laptop/study friendly' });
  }
  if (/\bbar seating\b|\bcounter seat\b/.test(q)) {
    constraints.push({ type: 'feature', label: 'bar or counter seating' });
  }

  // ── Group size ────────────────────────────────────────────────────────────
  if (/\bsolo\b|\balone\b|\bjust me\b|\bby myself\b|\bone person\b/.test(q)) {
    constraints.push({ type: 'group', label: 'solo dining' });
  }
  if (/\bdate\b|\bfor two\b|\bcouple\b/.test(q)) {
    constraints.push({ type: 'group', label: 'date for two' });
  }
  if (/\bgroup\b|\bparty of \d+\b|\blarge (group|party)\b|\bcrew\b/.test(q)) {
    constraints.push({ type: 'group', label: 'group friendly' });
  }

  // ── Budget ────────────────────────────────────────────────────────────────
  if (/\bcheap\b|\baffordable\b|\bbudget\b|\binexpensive\b|\bunder \$\d+\b/.test(q)) {
    constraints.push({ type: 'budget', label: 'budget-friendly' });
  }
  if (/\bsplurge\b|\bfancy\b|\bupscale\b|\bfine dining\b|\bspecial occasion\b/.test(q)) {
    constraints.push({ type: 'budget', label: 'upscale / splurge' });
  }

  // ── Dietary ───────────────────────────────────────────────────────────────
  if (/\bvegan\b/.test(q)) constraints.push({ type: 'dietary', label: 'vegan options' });
  if (/\bvegetarian\b/.test(q)) constraints.push({ type: 'dietary', label: 'vegetarian options' });
  if (/\bgluten.free\b/.test(q)) constraints.push({ type: 'dietary', label: 'gluten-free options' });
  if (/\bhalal\b/.test(q)) constraints.push({ type: 'dietary', label: 'halal' });
  if (/\bkosher\b/.test(q)) constraints.push({ type: 'dietary', label: 'kosher' });

  return constraints;
}

/**
 * Returns the search radius in meters for Google Places based on constraints.
 * Falls back to null (use default) if no distance constraint found.
 */
export function getConstraintRadius(constraints) {
  const dist = constraints.find((c) => c.type === 'distance');
  return dist?.radiusM ?? null;
}

/**
 * Format constraints as a concise block for Pepper's user message.
 */
export function formatConstraintsForPepper(constraints) {
  if (!constraints.length) return '';
  const lines = constraints.map((c) => `- ${c.label}`).join('\n');
  return `\nUser constraints (must address each one explicitly):\n${lines}\n`;
}
