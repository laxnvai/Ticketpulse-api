const TICKETMASTER_KEY = process.env.TICKETMASTER_KEY || '4UnoKjrhVNJbUxCaYZ2HdVMc5hVXOZqg';
const SEATGEEK_CLIENT_ID = process.env.SEATGEEK_CLIENT_ID;
const SEATGEEK_CLIENT_SECRET = process.env.SEATGEEK_CLIENT_SECRET;
const EVENTBRITE_TOKEN = process.env.EVENTBRITE_TOKEN;

const cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours - saves money
function getCached(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.timestamp > CACHE_TTL) { cache.delete(key); return null; }
  return item.data;
}
function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
  if (cache.size > 500) { cache.delete(cache.keys().next().value); }
}

const TM_CLASSIFICATIONS = { soccer:'Soccer', music:'Music', football:'Football', basketball:'Basketball', baseball:'Baseball', theater:'Arts & Theatre', comedy:'Comedy' };
const SG_TYPES = { soccer:'soccer', music:'concert', basketball:'nba', football:'nfl', baseball:'mlb', theater:'theater', comedy:'comedy' };

// FREE: Ticketmaster API
async function searchTicketmaster(query, category, location, maxPrice) {
  try {
    const classificationName = TM_CLASSIFICATIONS[category] || 'Music';
    // Try with classification first, then without if no results
    let url = `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${TICKETMASTER_KEY}&keyword=${encodeURIComponent(query)}&classificationName=${encodeURIComponent(classificationName)}&size=8&sort=date,asc`;
    if (location) { const city = location.split(',')[0].trim(); url += `&city=${encodeURIComponent(city)}`; }
    let tmR = await fetch(url);
    let tmData = tmR.ok ? await tmR.json() : {};
    let events = (tmData._embedded && tmData._embedded.events) || [];
    if (!events.length) {
      let url2 = `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${TICKETMASTER_KEY}&keyword=${encodeURIComponent(query)}&size=8&sort=date,asc`;
      if (location) { const city2 = location.split(',')[0].trim(); url2 += `&city=${encodeURIComponent(city2)}`; }
      const r2 = await fetch(url2);
      if (r2.ok) { const d2 = await r2.json(); events = (d2._embedded && d2._embedded.events) || []; }
    }
    // Filter keywords that indicate non-live events
    const EXCLUDE_KEYWORDS = ['watch party', 'viewing party', 'watch along', 'livestream', 'live stream', 'virtual', 'online event', 'broadcast', 'screening', 'tv party', 'pub screening', 'bar screening', 'fan zone viewing', 'watch the', 'watch at', 'big screen'];
    return events.map(e => {
      const venue = e._embedded && e._embedded.venues && e._embedded.venues[0];
      const priceRange = e.priceRanges && e.priceRanges[0];
      const price = priceRange ? `$${Math.round(priceRange.min)}` : 'Check site';
      const priceNum = priceRange ? Math.round(priceRange.min) : 0;
      const venueName = venue ? [venue.name, venue.city && venue.city.name, venue.state && venue.state.stateCode].filter(Boolean).join(', ') : 'TBA';
      const dateLocal = e.dates && e.dates.start && e.dates.start.localDate;
      if (dateLocal && new Date(dateLocal) < new Date()) return null;
      const date = dateLocal ? new Date(dateLocal).toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric'}) : 'TBA';
      if (maxPrice && priceNum && priceNum > maxPrice) return null;
      // Filter out watch parties and non-live events
      const nameLower = (e.name || '').toLowerCase();
      if (EXCLUDE_KEYWORDS.some(kw => nameLower.includes(kw))) return null;
      // Must have a real venue
      if (!venue || !venue.name) return null;
      // Filter out bars, pubs, restaurants and non-sports venues
      const venueNameLower = (venue.name || '').toLowerCase();
      const BAR_KEYWORDS = ['bar', 'pub', 'tavern', 'restaurant', 'cafe', 'brewery', 'lounge', 'inn', 'kitchen', 'grill', 'forum', 'club', 'hotel', 'hostel', 'arms', 'theatre', 'cinema', 'o2 forum', 'academy'];
      if (['soccer','football','basketball','baseball'].includes(category) && BAR_KEYWORDS.some(kw => venueNameLower.includes(kw))) return null;
      // For soccer/football, only accept US venues (World Cup 2026 is in USA)
      // Filter out events in UK/Europe for soccer searches
      if (category === 'soccer') {
        const countryCode = venue.country && venue.country.countryCode;
        if (countryCode && countryCode !== 'US' && countryCode !== 'CA' && countryCode !== 'MX') return null;
      }
      return { match: e.name, event: e.name, show: e.name, date, venue: venueName, price, price_number: priceNum, source: 'Ticketmaster', url: e.url, competition: '', distance: 'Check venue', verified: true, trust_reason: 'Official Ticketmaster listing', dateRaw: dateLocal };
    }).filter(Boolean);
  } catch(err) { console.error('[TM]', err.message); return []; }
}

// FREE: SeatGeek API
async function searchSeatGeek(query, category, location, maxPrice) {
  try {
    if (!SEATGEEK_CLIENT_ID) return [];
    const type = SG_TYPES[category] || 'concert';
    let url = `https://api.seatgeek.com/2/events?q=${encodeURIComponent(query)}&per_page=8&sort=datetime_asc&client_id=${SEATGEEK_CLIENT_ID}&client_secret=${SEATGEEK_CLIENT_SECRET}`;
    if (location) { const city = location.split(',')[0].trim(); url += `&venue.city=${encodeURIComponent(city)}`; }
    const r = await fetch(url);
    if (!r.ok) return [];
    const data = await r.json();
    const events = data.events || [];
    const SG_EXCLUDE = ['watch party', 'viewing party', 'watch along', 'livestream', 'virtual', 'online', 'screening'];
    return events.map(e => {
      const venue = e.venue;
      const price = e.stats && e.stats.lowest_price ? `$${Math.round(e.stats.lowest_price)}` : 'Check site';
      const priceNum = e.stats && e.stats.lowest_price ? Math.round(e.stats.lowest_price) : 0;
      const date = e.datetime_local ? new Date(e.datetime_local).toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric'}) : 'TBA';
      const venueName = venue ? [venue.name, venue.city, venue.state].filter(Boolean).join(', ') : 'TBA';
      if (maxPrice && priceNum && priceNum > maxPrice) return null;
      if (e.datetime_local && new Date(e.datetime_local) < new Date()) return null;
      const titleLower = (e.title || '').toLowerCase();
      if (SG_EXCLUDE.some(kw => titleLower.includes(kw))) return null;
      if (!venue || !venue.name) return null;
      return { match: e.title, event: e.title, show: e.title, date, venue: venueName, price, price_number: priceNum, source: 'SeatGeek', url: e.url, competition: '', distance: 'Check venue', verified: true, trust_reason: 'Official SeatGeek listing', dateRaw: e.datetime_local };
    }).filter(Boolean);
  } catch(err) { console.error('[SG]', err.message); return []; }
}

// FREE: Bandsintown API (music/comedy)
async function searchBandsintown(query, category) {
  if (category !== 'music' && category !== 'comedy') return [];
  try {
    const url = `https://rest.bandsintown.com/artists/${encodeURIComponent(query)}/events?app_id=seatgrab`;
    const r = await fetch(url);
    if (!r.ok) return [];
    const events = await r.json();
    if (!Array.isArray(events)) return [];
    return events.slice(0, 5).map(e => {
      const venue = e.venue || {};
      const date = e.datetime ? new Date(e.datetime).toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric'}) : 'TBA';
      if (e.datetime && new Date(e.datetime) < new Date()) return null;
      const venueName = [venue.name, venue.city, venue.region].filter(Boolean).join(', ');
      const ticketUrl = e.offers && e.offers[0] && e.offers[0].url ? e.offers[0].url : `https://www.bandsintown.com/a/${encodeURIComponent(query)}`;
      return { event: `${query} - ${e.title || 'Concert'}`, match: `${query} - ${e.title || 'Concert'}`, show: `${query} - ${e.title || 'Concert'}`, date, venue: venueName || 'TBA', price: 'Check site', price_number: 0, source: 'Bandsintown', url: ticketUrl, verified: true, trust_reason: 'Official Bandsintown listing', dateRaw: e.datetime };
    }).filter(Boolean);
  } catch(err) { console.error('[BIT]', err.message); return []; }
}

// FREE: Eventbrite API (comedy/theater)
async function searchEventbrite(query, category, location) {
  if (category !== 'comedy' && category !== 'theater') return [];
  try {
    if (!EVENTBRITE_TOKEN) return [];
    const catMap = { comedy: '103', theater: '105' };
    let url = `https://www.eventbriteapi.com/v3/events/search/?q=${encodeURIComponent(query)}&categories=${catMap[category]||'103'}&expand=venue,ticket_availability&sort_by=date&token=${EVENTBRITE_TOKEN}`;
    if (location) { const city = location.split(',')[0].trim(); url += `&location.address=${encodeURIComponent(city)}&location.within=50mi`; }
    const r = await fetch(url);
    if (!r.ok) return [];
    const data = await r.json();
    const events = data.events || [];
    return events.slice(0, 5).map(e => {
      const venue = e.venue || {};
      const date = e.start && e.start.local ? new Date(e.start.local).toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric'}) : 'TBA';
      if (e.start && e.start.local && new Date(e.start.local) < new Date()) return null;
      const venueName = [venue.name, venue.address && venue.address.city, venue.address && venue.address.region].filter(Boolean).join(', ');
      const ticket = e.ticket_availability || {};
      const price = ticket.minimum_ticket_price ? `$${Math.round(parseFloat(ticket.minimum_ticket_price.major_value))}` : (e.is_free ? 'Free' : 'Check site');
      const priceNum = ticket.minimum_ticket_price ? Math.round(parseFloat(ticket.minimum_ticket_price.major_value)) : 0;
      return { show: e.name && e.name.text || query, event: e.name && e.name.text || query, match: e.name && e.name.text || query, date, venue: venueName || 'TBA', price, price_number: priceNum, source: 'Eventbrite', url: e.url, verified: true, trust_reason: 'Official Eventbrite listing', dateRaw: e.start && e.start.local };
    }).filter(Boolean);
  } catch(err) { console.error('[EB]', err.message); return []; }
}

// FREE: TheSportsDB (basketball/football/baseball)
async function searchSportsDB(query, category) {
  if (!['basketball','football','baseball'].includes(category)) return [];
  try {
    const teamUrl = `https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(query)}`;
    const teamRes = await fetch(teamUrl);
    if (!teamRes.ok) return [];
    const teamData = await teamRes.json();
    const teams = teamData.teams || [];
    if (!teams.length) return [];
    const team = teams[0];
    const eventsUrl = `https://www.thesportsdb.com/api/v1/json/3/eventsnext.php?id=${team.idTeam}`;
    const eventsRes = await fetch(eventsUrl);
    if (!eventsRes.ok) return [];
    const eventsData = await eventsRes.json();
    const events = eventsData.events || [];
    return events.slice(0, 5).map(e => {
      const date = e.dateEvent ? new Date(e.dateEvent).toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric'}) : 'TBA';
      if (e.dateEvent && new Date(e.dateEvent) < new Date()) return null;
      const venueName = [e.strVenue, e.strCity].filter(Boolean).join(', ');
      const tmUrl = `https://www.ticketmaster.com/search?q=${encodeURIComponent(e.strEvent || query)}`;
      return { match: e.strEvent || `${query} game`, event: e.strEvent || `${query} game`, show: e.strEvent || `${query} game`, date, venue: venueName || 'TBA', price: 'Check site', price_number: 0, source: 'TheSportsDB', url: tmUrl, league: e.strLeague || '', verified: true, trust_reason: 'Official schedule data', dateRaw: e.dateEvent };
    }).filter(Boolean);
  } catch(err) { console.error('[SDB]', err.message); return []; }
}

// FREE: Smart price prediction without AI
function smartPricePrediction(tickets, query, category) {
  if (!tickets || !tickets.length) return null;
  const now = new Date();
  let earliestDate = null;
  let lowestPrice = 9999;
  let highestPrice = 0;

  tickets.forEach(t => {
    if (t.dateRaw) {
      const d = new Date(t.dateRaw);
      if (!earliestDate || d < earliestDate) earliestDate = d;
    }
    if (t.price_number && t.price_number > 0) {
      if (t.price_number < lowestPrice) lowestPrice = t.price_number;
      if (t.price_number > highestPrice) highestPrice = t.price_number;
    }
  });

  const daysUntil = earliestDate ? Math.ceil((earliestDate - now) / 86400000) : 999;
  const priceSpread = highestPrice - lowestPrice;

  let recommendation, trend, badge, reason;

  if (daysUntil <= 7) {
    recommendation = 'buy_now';
    trend = 'rising';
    badge = 'Prices rising fast';
    reason = 'Event is in ' + daysUntil + ' days - prices typically spike in the last week.';
  } else if (daysUntil <= 30) {
    recommendation = 'buy_now';
    trend = 'rising';
    badge = 'Buy soon';
    reason = 'Less than a month away - prices usually rise as the event approaches.';
  } else if (daysUntil <= 60) {
    recommendation = 'uncertain';
    trend = 'stable';
    badge = 'Good deal now';
    reason = 'About ' + Math.round(daysUntil/30) + ' months away - prices are typically stable right now.';
  } else if (daysUntil > 90) {
    recommendation = 'wait';
    trend = 'falling';
    badge = 'Wait for drops';
    reason = 'Event is more than 3 months away - prices may drop closer to the date.';
  } else {
    recommendation = 'uncertain';
    trend = 'stable';
    badge = 'Prices stable';
    reason = 'Prices appear stable. Monitor daily for any drops.';
  }

  if (priceSpread > lowestPrice * 0.5 && lowestPrice < 9999) {
    recommendation = 'buy_now';
    badge = 'Best time to buy';
    reason = reason + ' Big price variation found - grab the lowest price now.';
  }

  return { trend, confidence: daysUntil <= 30 ? 'high' : 'medium', recommendation, reason, badge };
}

// FREE: Smart recommendations based on history
function smartRecommendations(savedSearches, location) {
  if (!savedSearches || !savedSearches.length) return [];
  const cats = {};
  savedSearches.forEach(s => { cats[s.category] = (cats[s.category] || 0) + 1; });
  const topCat = Object.keys(cats).sort((a,b) => cats[b]-cats[a])[0];
  const SUGGESTIONS = {
    soccer: [{name:'FIFA World Cup 2026',category:'soccer',reason:'Biggest soccer event in the world happening right now in USA',date:'June-July 2026',venue:'Multiple US cities',price_estimate:'$500-$2000',search_query:'FIFA World Cup'},{name:'MLS Games Near You',category:'soccer',reason:'Local professional soccer you might enjoy',date:'Upcoming',venue:location||'Your city',price_estimate:'$25-$150',search_query:'MLS soccer'}],
    music: [{name:'Sabrina Carpenter Tour',category:'music',reason:'One of the hottest artists right now',date:'2026',venue:'Major US cities',price_estimate:'$80-$400',search_query:'Sabrina Carpenter'},{name:'Coldplay World Tour',category:'music',reason:'Legendary band with incredible live shows',date:'2026',venue:'Major US cities',price_estimate:'$100-$500',search_query:'Coldplay'}],
    basketball: [{name:'NBA Playoffs',category:'basketball',reason:'Most exciting time in basketball',date:'Spring 2027',venue:'Major US cities',price_estimate:'$100-$800',search_query:'NBA Playoffs'},{name:'Lakers vs Celtics',category:'basketball',reason:'Greatest rivalry in NBA history',date:'Upcoming',venue:'Various',price_estimate:'$150-$600',search_query:'Lakers'}],
    football: [{name:'Dallas Cowboys',category:'football',reason:'Americas Team - always a great game',date:'Fall 2026',venue:'AT&T Stadium, Arlington TX',price_estimate:'$80-$500',search_query:'Dallas Cowboys'},{name:'NFL Playoffs',category:'football',reason:'Most watched sporting event in America',date:'January 2027',venue:'Various',price_estimate:'$200-$1000',search_query:'NFL Playoffs'}],
    baseball: [{name:'World Series',category:'baseball',reason:'Championship of Americas favorite pastime',date:'October 2026',venue:'TBD',price_estimate:'$200-$1500',search_query:'World Series'},{name:'Yankees vs Red Sox',category:'baseball',reason:'Greatest rivalry in baseball',date:'Upcoming',venue:'Various',price_estimate:'$50-$300',search_query:'Yankees'}],
    theater: [{name:'Hamilton',category:'theater',reason:'Award-winning musical everyone should see',date:'Ongoing',venue:'Broadway, New York',price_estimate:'$100-$400',search_query:'Hamilton'},{name:'Wicked',category:'theater',reason:'Classic musical with stunning performances',date:'Ongoing',venue:'Various',price_estimate:'$80-$300',search_query:'Wicked'}],
    comedy: [{name:'Dave Chappelle',category:'comedy',reason:'One of the greatest comedians of our time',date:'2026',venue:'Various',price_estimate:'$80-$200',search_query:'Dave Chappelle'},{name:'Kevin Hart',category:'comedy',reason:'Hilarious shows perfect for a night out',date:'2026',venue:'Various',price_estimate:'$60-$180',search_query:'Kevin Hart'}]
  };
  return (SUGGESTIONS[topCat] || SUGGESTIONS.music).slice(0, 4);
}

// Merge and deduplicate tickets
function mergeTickets(arrays, maxPrice) {
  const seen = new Set();
  const merged = [].concat(...arrays).filter(t => {
    if (!t) return false;
    const key = (t.match || t.event || '').toLowerCase().substring(0, 30) + (t.date || '');
    if (seen.has(key)) return false;
    seen.add(key);
    if (maxPrice && t.price_number && t.price_number > maxPrice) return false;
    return true;
  });
  return merged.sort((a, b) => (a.price_number || 9999) - (b.price_number || 9999));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const path = req.url.split('?')[0];

  if (req.method === 'GET' && (path === '/api' || path === '/api/')) return res.json({ status: 'SeatGrab API running! 100% free.' });
  if (req.method === 'GET' && path === '/api/warmup') return res.json({ status: 'warm', time: Date.now() });
  if (req.method === 'GET' && path === '/api/health') return res.json({ status: 'ok', cache: cache.size, cost: 'FREE' });

  if (req.method === 'GET' && path.startsWith('/api/reviews/')) {
    const eventName = decodeURIComponent(path.replace('/api/reviews/', ''));
    const reviews = getCached('reviews:' + eventName.toLowerCase()) || [];
    return res.json({ reviews });
  }

  if (req.method !== 'POST') return res.status(404).json({ error: 'Not found' });
  const body = req.body || {};

  // PREFETCH - free, instant
  if (path === '/api/prefetch') {
    const { searches } = body;
    if (!searches || !searches.length) return res.json({ prefetched: 0 });
    let prefetched = 0;
    await Promise.all(searches.slice(0, 3).map(async s => {
      const key = `${s.category}:${s.query.toLowerCase()}:${s.location||''}`;
      if (getCached(key)) { prefetched++; return; }
      try {
        const [tm, sg] = await Promise.all([
          searchTicketmaster(s.query, s.category, s.location, null),
          searchSeatGeek(s.query, s.category, s.location, null)
        ]);
        const tickets = mergeTickets([tm, sg], null);
        if (tickets.length) { setCache(key, { tickets, prediction: null, flights: [], hotels: [] }); prefetched++; }
      } catch(e) {}
    }));
    return res.json({ prefetched });
  }

  // MAIN SEARCH - 100% free
  if (path === '/api/search') {
    const { query, category, maxPrice, location } = body;
    if (!query || !category) return res.status(400).json({ error: 'Missing query or category' });
    const cacheKey = `${category}:${query.toLowerCase()}:${maxPrice||''}:${location||''}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json({ ...cached, fromCache: true });

    // Search all free APIs in parallel
    const [tmTickets, sgTickets, bitTickets, ebTickets, sdbTickets] = await Promise.all([
      searchTicketmaster(query, category, location, maxPrice),
      searchSeatGeek(query, category, location, maxPrice),
      searchBandsintown(query, category),
      searchEventbrite(query, category, location),
      searchSportsDB(query, category)
    ]);

    console.log(`[TM]${tmTickets.length} [SG]${sgTickets.length} [BIT]${bitTickets.length} [EB]${ebTickets.length} [SDB]${sdbTickets.length}`);

    const allTickets = mergeTickets([tmTickets, sgTickets, bitTickets, ebTickets, sdbTickets], maxPrice);
    
    // Separate real tickets from watch parties
    const WATCH_KEYWORDS = ['watch party', 'viewing party', 'watch along', 'livestream', 'live stream', 'virtual', 'online event', 'screening', 'tv party', 'watch event'];
    const tickets = allTickets.filter(t => !WATCH_KEYWORDS.some(kw => (t.match||t.event||'').toLowerCase().includes(kw)));
    const watchParties = allTickets.filter(t => WATCH_KEYWORDS.some(kw => (t.match||t.event||'').toLowerCase().includes(kw)));

    // FREE smart prediction - no AI needed
    const prediction = smartPricePrediction(tickets, query, category);

    const result = { tickets, watchParties, prediction, flights: [], hotels: [], fromCache: false };
    if (tickets.length) setCache(cacheKey, result);
    return res.json(result);
  }

  // TRAVEL - free deep links
  if (path === '/api/travel') {
    const { userCity, eventVenue, eventDate } = body;
    if (!userCity || !eventVenue) return res.status(400).json({ error: 'Missing fields' });
    const venueParts = eventVenue.split(',');
    const eventCityShort = venueParts.length >= 2 ? venueParts[venueParts.length - 2].trim() : eventVenue;
    const userCityShort = userCity.split(',')[0].trim();
    let dateStr = '';
    if (eventDate) { try { const d = new Date(eventDate); if (!isNaN(d)) dateStr = d.toISOString().split('T')[0]; } catch(e) {} }
    const flights = [
      { source: 'Google Flights', price: 'Search for live prices', price_number: 0, url: `https://www.google.com/travel/flights?q=Flights+from+${encodeURIComponent(userCityShort)}+to+${encodeURIComponent(eventCityShort)}${dateStr?'+on+'+dateStr:''}`, verified: true, description: 'Compare all airlines on Google Flights' },
      { source: 'Kayak', price: 'Search for live prices', price_number: 0, url: `https://www.kayak.com/flights/${encodeURIComponent(userCityShort)}-${encodeURIComponent(eventCityShort)}${dateStr?'/'+dateStr:''}`, verified: true, description: 'Find deals on Kayak' },
      { source: 'Expedia', price: 'Search for live prices', price_number: 0, url: `https://www.expedia.com/Flights-Search?trip=oneway&leg1=from:${encodeURIComponent(userCityShort)},to:${encodeURIComponent(eventCityShort)}`, verified: true, description: 'Book with Expedia price guarantee' }
    ];
    const hotels = [
      { source: 'Booking.com', price_per_night: 'Search for live prices', price_number: 0, url: `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(eventCityShort)}&checkin=${dateStr||''}&group_adults=1&no_rooms=1`, verified: true, description: 'Worlds largest hotel selection' },
      { source: 'Hotels.com', price_per_night: 'Search for live prices', price_number: 0, url: `https://www.hotels.com/search.do?q-destination=${encodeURIComponent(eventCityShort)}&q-check-in=${dateStr||''}`, verified: true, description: 'Great deals on Hotels.com' }
    ];
    return res.json({ flights, hotels, destination: eventVenue, fromCache: false });
  }

  // REVIEWS
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

  // COMPARE - uses cached results, free
  if (path === '/api/compare') {
    const { query, category } = body;
    if (!query) return res.status(400).json({ error: 'Missing query' });
    const cacheKey = `${category}:${query.toLowerCase()}::`;
    const cached = getCached(cacheKey);
    const tickets = cached ? cached.tickets : [];
    if (tickets.length) {
      const comparisons = tickets
        .filter(t => t.price_number && t.price_number > 0)
        .sort((a,b) => a.price_number - b.price_number)
        .map(t => ({ source: t.source, price: t.price, price_number: t.price_number, url: t.url, section: t.venue }));
      return res.json({ comparisons, fromCache: true });
    }
    return res.json({ comparisons: [], fromCache: false });
  }

  // DIGEST - uses cached data, free
  if (path === '/api/digest') {
    const { searches } = body;
    if (!searches || !searches.length) return res.status(400).json({ error: 'No searches' });
    const results = [];
    for (const s of searches.slice(0, 5)) {
      const key = `${s.category}:${s.query.toLowerCase()}::`;
      const cached = getCached(key);
      let tickets = cached ? cached.tickets : [];
      if (!tickets.length) {
        try {
          const [tm, sg] = await Promise.all([searchTicketmaster(s.query, s.category, '', null), searchSeatGeek(s.query, s.category, '', null)]);
          tickets = mergeTickets([tm, sg], null);
        } catch(e) {}
      }
      if (tickets.length) results.push({ query: s.query, category: s.category, tickets: tickets.slice(0, 3) });
    }
    return res.json({ results });
  }

  // RECOMMENDATIONS - smart, free
  if (path === '/api/recommendations') {
    const { savedSearches, location } = body;
    const recommendations = smartRecommendations(savedSearches, location);
    return res.json({ recommendations });
  }

  // WATCH - uses Ticketmaster + SeatGeek, free
  if (path === '/api/watch') {
    const { query, category, location } = body;
    if (!query || !location) return res.status(400).json({ error: 'Missing fields' });
    const [tm, sg] = await Promise.all([
      searchTicketmaster(query, category, location, null),
      searchSeatGeek(query, category, location, null)
    ]);
    const events = mergeTickets([tm, sg], null).map(t => ({
      event: t.match || t.event || t.show || query,
      date: t.date,
      venue: t.venue,
      price_estimate: t.price,
      url: t.url
    }));
    return res.json({ events, query, location, category });
  }

  return res.status(404).json({ error: 'Not found' });
}
