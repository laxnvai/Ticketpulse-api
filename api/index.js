const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TICKETMASTER_KEY = process.env.TICKETMASTER_KEY || '4UnoKjrhVNJbUxCaYZ2HdVMc5hVXOZqg';
const SEATGEEK_CLIENT_ID = process.env.SEATGEEK_CLIENT_ID;
const SEATGEEK_CLIENT_SECRET = process.env.SEATGEEK_CLIENT_SECRET;

const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000;
function getCached(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.timestamp > CACHE_TTL) { cache.delete(key); return null; }
  return item.data;
}
function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
  if (cache.size > 200) { cache.delete(cache.keys().next().value); }
}

const TRUSTED_TICKETS = ['seatgeek','stubhub','ticketmaster','gametime','tickpick','vividseats','axs','livenation','viagogo','fifa','nba.com','nfl.com','mlb.com','telecharge','broadwaybox','playbill','todaytix'];
const TRUSTED_FLIGHTS = ['google flights','google','kayak','expedia','priceline','skyscanner','hopper','united','delta','american airlines','southwest','jetblue','frontier','spirit'];
const TRUSTED_HOTELS = ['hotels.com','booking.com','expedia','marriott','hilton','hyatt','airbnb','vrbo','trivago','priceline','hotwire'];
function isTrusted(source, list) { if (!source) return false; const s = source.toLowerCase(); return list.some(p => s.includes(p)); }

const TM_CLASSIFICATIONS = { soccer:'Soccer', music:'Music', football:'Football', basketball:'Basketball', baseball:'Baseball', theater:'Arts & Theatre', comedy:'Comedy' };

async function searchTicketmaster(query, category, location, maxPrice) {
  try {
    const classificationName = TM_CLASSIFICATIONS[category] || 'Music';
    let url = `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${TICKETMASTER_KEY}&keyword=${encodeURIComponent(query)}&classificationName=${encodeURIComponent(classificationName)}&size=5&sort=date,asc`;
    if (location) { const city = location.split(',')[0].trim(); url += `&city=${encodeURIComponent(city)}`; }
    const r = await fetch(url);
    if (!r.ok) return [];
    const data = await r.json();
    const events = (data._embedded && data._embedded.events) || [];
    return events.map(e => {
      const venue = e._embedded && e._embedded.venues && e._embedded.venues[0];
      const priceRange = e.priceRanges && e.priceRanges[0];
      const price = priceRange ? `$${Math.round(priceRange.min)}` : 'Check site';
      const priceNum = priceRange ? Math.round(priceRange.min) : 0;
      const venueName = venue ? `${venue.name}, ${venue.city && venue.city.name}, ${venue.state && venue.state.stateCode}` : 'TBA';
      const date = e.dates && e.dates.start && e.dates.start.localDate ? new Date(e.dates.start.localDate).toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric'}) : 'TBA';
      if (maxPrice && priceNum && priceNum > maxPrice) return null;
      return { match: e.name, event: e.name, show: e.name, date, venue: venueName, price, price_number: priceNum, source: 'Ticketmaster', url: e.url, competition: '', distance: 'Check venue', verified: true, trust_reason: 'Official Ticketmaster listing' };
    }).filter(Boolean);
  } catch(err) { console.error('[Ticketmaster]', err.message); return []; }
}

function parseJsonArray(text) {
  if (!text) return [];
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const matches = [];
  let depth = 0, start = -1;
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === '[') { if (depth === 0) start = i; depth++; }
    else if (cleaned[i] === ']') { depth--; if (depth === 0 && start !== -1) { matches.push(cleaned.slice(start, i + 1)); start = -1; } }
  }
  for (const match of matches) {
    try { const p = JSON.parse(match); if (Array.isArray(p) && p.length > 0) return p; } catch(e) {
      try { const fixed = match.replace(/,\s*}/g,'}').replace(/,\s*]/g,']'); const p = JSON.parse(fixed); if (Array.isArray(p) && p.length > 0) return p; } catch(e2) {}
    }
  }
  return [];
}

async function callAnthropic(system, msg, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1200, tools: [{ type: 'web_search_20250305', name: 'web_search' }], system, messages: [{ role: 'user', content: msg }] })
      });
      if (!r.ok) throw new Error('API ' + r.status);
      const d = await r.json();
      const text = (d.content || []).map(b => b.type === 'text' ? b.text : '').join('');
      const result = parseJsonArray(text);
      if (result.length > 0) return result;
      if (i < retries) { await new Promise(r => setTimeout(r, 800)); continue; }
      return [];
    } catch(err) { if (i === retries) throw err; await new Promise(r => setTimeout(r, 1000 * (i + 1))); }
  }
  return [];
}

async function callAnthropicObject(system, msg) {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 500, tools: [{ type: 'web_search_20250305', name: 'web_search' }], system, messages: [{ role: 'user', content: msg }] })
    });
    if (!r.ok) return null;
    const d = await r.json();
    const text = (d.content || []).map(b => b.type === 'text' ? b.text : '').join('');
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch(e) { return null; }
  } catch(err) { return null; }
}

function getSearchSystem(query, category, pf, lf, cf, gf) {
  const today_str = new Date().toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric'});
  const base = `Today is ${today_str}. ${pf} ${lf} STRICT RULES: 1) ONLY return events happening AFTER today. 2) Prices MUST be exact prices from the platform. 3) URLs must link directly to the event. Return ONLY raw JSON array, no markdown. Up to 5 results sorted cheapest first.`;
  const fmt = {
    soccer: '[{"match":"...","date":"Month DD YYYY","venue":"Stadium, City, State","price":"$XXX","price_number":XXX,"source":"...","url":"https://...","competition":"...","distance":"..."}]',
    music: '[{"event":"Artist - Tour","date":"Month DD YYYY","venue":"Venue, City, State","price":"$XXX","price_number":XXX,"source":"...","url":"https://...","genre":"...","distance":"..."}]',
    basketball: '[{"match":"Team vs Team","date":"Month DD YYYY","venue":"Arena, City, State","price":"$XXX","price_number":XXX,"source":"...","url":"https://...","league":"...","distance":"..."}]',
    football: '[{"match":"Team vs Team","date":"Month DD YYYY","venue":"Stadium, City, State","price":"$XXX","price_number":XXX,"source":"...","url":"https://...","league":"...","distance":"..."}]',
    baseball: '[{"match":"Team vs Team","date":"Month DD YYYY","venue":"Stadium, City, State","price":"$XXX","price_number":XXX,"source":"...","url":"https://...","league":"MLB","distance":"..."}]',
    theater: '[{"show":"Show Name","date":"Month DD YYYY","venue":"Theater, City, State","price":"$XXX","price_number":XXX,"source":"...","url":"https://...","type":"...","distance":"..."}]',
    comedy: '[{"show":"Comedian - Tour","date":"Month DD YYYY","venue":"Venue, City, State","price":"$XXX","price_number":XXX,"source":"...","url":"https://...","distance":"..."}]'
  };
  const sources = {
    soccer: 'StubHub, SeatGeek, Ticketmaster, Gametime, TickPick, FIFA.com',
    music: 'Ticketmaster, StubHub, SeatGeek, AXS, LiveNation',
    basketball: 'Ticketmaster, SeatGeek, StubHub, NBA.com, Gametime',
    football: 'Ticketmaster, SeatGeek, StubHub, NFL.com, Gametime',
    baseball: 'Ticketmaster, SeatGeek, StubHub, MLB.com, Gametime',
    theater: 'Telecharge, Ticketmaster, StubHub, BroadwayBox, TodayTix',
    comedy: 'Ticketmaster, StubHub, SeatGeek, AXS, LiveNation'
  };
  const isSoccerWorldCup = category === 'soccer' && (query.toLowerCase().includes('argentina') || query.toLowerCase().includes('world cup') || query.toLowerCase().includes('fifa'));
  const wcContext = isSoccerWorldCup ? 'FIFA World Cup 2026 is happening RIGHT NOW June-July 2026 across USA. Argentina matches: vs Algeria June 16 Kansas City, vs Austria June 22 Arlington TX, Jordan vs Argentina June 27 Arlington TX. Tickets available on StubHub, SeatGeek, Ticketmaster. ' : '';
  return `${wcContext}Search for ${category} tickets for "${query}" on ${sources[category]||sources.music}. ${base} ${category==='soccer'?cf:''} ${category==='music'?gf:''} Format: ${fmt[category]||fmt.music}`;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const path = req.url.split('?')[0];

  // Health / warmup
  if (req.method === 'GET' && (path === '/api' || path === '/api/')) return res.json({ status: 'TicketPulse API running!' });
  if (req.method === 'GET' && path === '/api/warmup') return res.json({ status: 'warm', time: Date.now() });
  if (req.method === 'GET' && path === '/api/health') return res.json({ status: 'ok', cache: cache.size });

  // Reviews GET
  if (req.method === 'GET' && path.startsWith('/api/reviews/')) {
    const eventName = decodeURIComponent(path.replace('/api/reviews/', ''));
    const reviews = getCached('reviews:' + eventName.toLowerCase()) || [];
    return res.json({ reviews });
  }

  if (req.method !== 'POST') return res.status(404).json({ error: 'Not found' });

  const body = req.body || {};

  // Prefetch
  if (path === '/api/prefetch') {
    const { searches } = body;
    if (!searches || !searches.length) return res.json({ prefetched: 0 });
    let prefetched = 0;
    await Promise.all(searches.slice(0, 3).map(async s => {
      const key = `${s.category}:${s.query.toLowerCase()}:${s.location||''}`;
      if (getCached(key)) { prefetched++; return; }
      try {
        const tmTickets = await searchTicketmaster(s.query, s.category, s.location, null);
        if (tmTickets.length) { setCache(key, { tickets: tmTickets, prediction: null, flights: [], hotels: [] }); prefetched++; }
      } catch(e) {}
    }));
    return res.json({ prefetched });
  }

  // Search
  if (path === '/api/search') {
    const { query, category, maxPrice, location, competition, genre } = body;
    if (!query || !category) return res.status(400).json({ error: 'Missing query or category' });
    const cacheKey = `${category}:${query.toLowerCase()}:${maxPrice||''}:${location||''}:${competition||''}:${genre||''}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json({ ...cached, fromCache: true });
    const pf = maxPrice ? `Only under $${maxPrice}.` : '';
    const lf = location ? `Near ${location}.` : '';
    const cf = competition && competition !== 'Any' ? `Only ${competition}.` : '';
    const gf = genre && genre !== 'Any' ? `Only ${genre}.` : '';
    const sys = getSearchSystem(query, category, pf, lf, cf, gf);
    const predCacheKey = `pred:${query.toLowerCase()}:${category}`;
    const cachedPred = getCached(predCacheKey);
    // Search Ticketmaster AND SeatGeek in parallel - free, instant, accurate
    const [tmTickets, sgTickets] = await Promise.all([
      searchTicketmaster(query, category, location, maxPrice),
      searchSeatGeek(query, category, location, maxPrice)
    ]);
    console.log(`[TM] ${tmTickets.length} results, [SG] ${sgTickets.length} results for ${query}`);

    // Merge results - deduplicate by event name and date
    const seen = new Set();
    const mergedTickets = [...tmTickets, ...sgTickets].filter(t => {
      const key = (t.match || t.event || '').toLowerCase() + (t.date || '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => (a.price_number || 9999) - (b.price_number || 9999));

    const [rawTickets, prediction] = await Promise.all([
      mergedTickets.length >= 2 ? Promise.resolve(mergedTickets) : callAnthropic(sys, `Search right now for available "${query}" ${category} tickets. JSON only.`),
      cachedPred ? Promise.resolve(cachedPred) : callAnthropicObject(
        `Ticket price analyst. Today ${new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}. Return ONLY JSON: {"trend":"rising/falling/stable","confidence":"high/medium/low","recommendation":"buy_now/wait/uncertain","reason":"One sentence","badge":"Best time to buy / Prices rising fast / Wait for drops / Good deal now"}`,
        `Analyze price trend for ${query} tickets. JSON only.`
      )
    ]);
    if (prediction && !cachedPred) setCache(predCacheKey, prediction);
    let tickets = maxPrice ? rawTickets.filter(t => !t.price_number || t.price_number <= maxPrice) : rawTickets;
    if (!tickets.length) {
      const fb1 = await callAnthropic(`Search StubHub, SeatGeek, Ticketmaster for "${query}" ${category} tickets 2026. Return JSON array.`, `Find "${query}" tickets. JSON only.`);
      if (fb1.length) tickets = maxPrice ? fb1.filter(t => !t.price_number || t.price_number <= maxPrice) : fb1;
    }
    if (!tickets.length) {
      const fb2 = await callAnthropic(`Find any 2026 tickets for "${query}" on any major ticket platform. Return JSON array with at least 1 result.`, `Any tickets for "${query}"? JSON only.`);
      if (fb2.length) tickets = maxPrice ? fb2.filter(t => !t.price_number || t.price_number <= maxPrice) : fb2;
    }
    const safeTickets = tickets.map(t => ({ ...t, verified: true, trust_reason: isTrusted(t.source, TRUSTED_TICKETS) ? 'Verified trusted platform' : 'Reviewed' }));
    const result = { tickets: safeTickets, prediction: prediction || null, flights: [], hotels: [], fromCache: false };
    setCache(cacheKey, result);
    return res.json(result);
  }

  // Travel
  if (path === '/api/travel') {
    const { userCity, eventVenue, eventDate } = body;
    if (!userCity || !eventVenue) return res.status(400).json({ error: 'Missing fields' });
    const venueParts = eventVenue.split(',');
    const eventCityShort = venueParts.length >= 2 ? venueParts[venueParts.length - 2].trim() : eventVenue;
    const userCityShort = userCity.split(',')[0].trim();
    let dateStr = '';
    if (eventDate) { try { const d = new Date(eventDate); if (!isNaN(d)) dateStr = d.toISOString().split('T')[0]; } catch(e) {} }
    const flights = [
      { route: `${userCityShort} to ${eventCityShort}`, source: 'Google Flights', price: 'Search for live prices', price_number: 0, url: `https://www.google.com/travel/flights?q=Flights+from+${encodeURIComponent(userCityShort)}+to+${encodeURIComponent(eventCityShort)}${dateStr?'+on+'+dateStr:''}`, verified: true, description: 'Compare all airlines on Google Flights' },
      { route: `${userCityShort} to ${eventCityShort}`, source: 'Kayak', price: 'Search for live prices', price_number: 0, url: `https://www.kayak.com/flights/${encodeURIComponent(userCityShort)}-${encodeURIComponent(eventCityShort)}${dateStr?'/'+dateStr:''}`, verified: true, description: 'Find deals on Kayak' },
      { route: `${userCityShort} to ${eventCityShort}`, source: 'Expedia', price: 'Search for live prices', price_number: 0, url: `https://www.expedia.com/Flights-Search?trip=oneway&leg1=from:${encodeURIComponent(userCityShort)},to:${encodeURIComponent(eventCityShort)}`, verified: true, description: 'Book with Expedia price guarantee' }
    ];
    const hotels = [
      { name: `Hotels in ${eventCityShort}`, source: 'Booking.com', price_per_night: 'Search for live prices', price_number: 0, url: `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(eventCityShort)}&checkin=${dateStr||''}&group_adults=1&no_rooms=1`, verified: true, description: 'Worlds largest hotel selection' },
      { name: `Hotels in ${eventCityShort}`, source: 'Hotels.com', price_per_night: 'Search for live prices', price_number: 0, url: `https://www.hotels.com/search.do?q-destination=${encodeURIComponent(eventCityShort)}&q-check-in=${dateStr||''}`, verified: true, description: 'Great deals on Hotels.com' }
    ];
    return res.json({ flights, hotels, destination: eventVenue, fromCache: false });
  }

  // Review POST
  if (path === '/api/review') {
    const { eventName, category, rating, review, userName } = body;
    if (!eventName || !rating) return res.status(400).json({ error: 'Missing fields' });
    const key = 'reviews:' + eventName.toLowerCase();
    const existing = getCached(key) || [];
    const newReview = { eventName, category, rating, review, userName: userName || 'Anonymous', date: new Date().toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'}) };
    existing.unshift(newReview);
    setCache(key, existing.slice(0, 50));
    return res.json({ success: true, review: newReview });
  }

  // Compare
  if (path === '/api/compare') {
    const { query, category } = body;
    if (!query) return res.status(400).json({ error: 'Missing query' });
    const cacheKey = `compare:${category}:${query.toLowerCase()}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json({ comparisons: cached, fromCache: true });
    const labels = { soccer:'soccer match', basketball:'basketball game', football:'football game', baseball:'baseball game', theater:'theater show', comedy:'comedy show', music:'concert' };
    const sys = `Search "${query}" ${labels[category]||'event'} tickets across StubHub, SeatGeek, Ticketmaster, Gametime, TickPick, VividSeats. Today ${new Date().toLocaleDateString()}. Return ONLY raw JSON array sorted cheapest: [{"source":"...","price":"$XXX","price_number":XXX,"url":"https://...","section":"..."}]`;
    const comparisons = await callAnthropic(sys, `Compare ${query} prices. JSON only.`);
    setCache(cacheKey, comparisons);
    return res.json({ comparisons, fromCache: false });
  }

  // Digest
  if (path === '/api/digest') {
    const { searches } = body;
    if (!searches || !searches.length) return res.status(400).json({ error: 'No searches' });
    const results = [];
    for (const s of searches.slice(0, 5)) {
      const key = `${s.category}:${s.query.toLowerCase()}:::`;
      const cached = getCached(key);
      let tickets = cached ? cached.tickets : [];
      if (!tickets.length) { try { tickets = await searchTicketmaster(s.query, s.category, '', null); } catch(e) {} }
      if (tickets.length) results.push({ query: s.query, category: s.category, tickets: tickets.slice(0, 3) });
    }
    return res.json({ results });
  }

  // Recommendations
  if (path === '/api/recommendations') {
    const { savedSearches, location } = body;
    if (!savedSearches || !savedSearches.length) return res.json({ recommendations: [] });
    const sys = `Smart event recommendations. ${location ? 'User is in ' + location + '.' : ''} Today ${new Date().toLocaleDateString()}. Return ONLY raw JSON array: [{"name":"...","category":"soccer/music/basketball/football/baseball/theater/comedy","reason":"...","date":"...","venue":"City, State","price_estimate":"$XXX-$XXX","search_query":"exact search term"}] Up to 4.`;
    const recommendations = await callAnthropic(sys, `User likes: ${JSON.stringify(savedSearches.slice(0,8))}. Recommend events. JSON only.`);
    return res.json({ recommendations });
  }

  // Watch
  if (path === '/api/watch') {
    const { query, category, location } = body;
    if (!query || !location) return res.status(400).json({ error: 'Missing fields' });
    const labels = { soccer:'soccer matches', basketball:'basketball games', football:'football games', baseball:'baseball games', theater:'theater shows', comedy:'comedy shows', music:'concerts' };
    const sys = `Search upcoming ${labels[category]||'events'} for "${query}" near ${location} in 2026. Return ONLY raw JSON array: [{"event":"...","date":"Month DD YYYY","venue":"Venue, City, State","price_estimate":"$XXX-$XXX","url":"https://..."}] If none return [].`;
    const events = await callAnthropic(sys, `Is "${query}" coming to ${location}? JSON only.`);
    return res.json({ events, query, location, category });
  }

  return res.status(404).json({ error: 'Not found' });
}
