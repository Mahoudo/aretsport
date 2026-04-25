/**
 * AretSport Proxy Server - Node.js version
 * Aggregates football matches from betclic.ci + Sofascore
 */

const http = require('http');
const https = require('https');
const PORT = parseInt(process.env.PORT || '8090');

// ─── HTTP Helper ──────────────────────────────────────────────────────────────
function fetchUrl(url, headers = {}, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
function today() {
  return new Date().toISOString().slice(0, 10);
}
function tomorrow() {
  const d = new Date(); d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}
function tsToTimeAndDate(ts) {
  const d = new Date(ts * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return {
    time: `${hh}:${mm}`,
    date: d.toISOString().slice(0, 10)
  };
}

// ─── Sofascore ────────────────────────────────────────────────────────────────
const SOFA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.sofascore.com/',
};
const STATUS_MAP = { notstarted: 'upcoming', inprogress: 'live', finished: 'finished', postponed: 'postponed', canceled: 'canceled' };

async function fetchSofascore(dateStr) {
  try {
    const { status, body } = await fetchUrl(
      `https://api.sofascore.com/api/v1/sport/football/scheduled-events/${dateStr}`,
      SOFA_HEADERS
    );
    if (status !== 200) return [];
    const data = JSON.parse(body);
    const events = data.events || [];
    const results = [];
    for (const ev of events) {
      try {
        const home = ev.homeTeam?.name || '';
        const away = ev.awayTeam?.name || '';
        if (!home || !away) continue;

        let league = ev.tournament?.name || '';
        const category = ev.tournament?.category?.name || '';
        if (category && !league.includes(category)) league = `${category} • ${league}`;

        const { time, date } = ev.startTimestamp ? tsToTimeAndDate(ev.startTimestamp) : { time: '', date: dateStr };
        const rawStatus = ev.status?.type || 'notstarted';
        const matchStatus = STATUS_MAP[rawStatus] || 'upcoming';

        let minute = null, score = null;
        if (matchStatus === 'live' || matchStatus === 'finished') {
          const hc = ev.homeScore?.current;
          const ac = ev.awayScore?.current;
          if (hc != null && ac != null) score = { home: String(hc), away: String(ac) };
          if (matchStatus === 'live' && ev.time?.currentPeriodStartTimestamp) {
            minute = Math.min(Math.floor((Date.now() / 1000 - ev.time.currentPeriodStartTimestamp) / 60), 90);
          }
        }

        results.push({
          id: `ss_${ev.id}`,
          source: 'sofascore',
          league, home, away, time, date,
          minute, score,
          status: matchStatus,
          odds: { '1': null, X: null, '2': null },
          url: `https://www.sofascore.com/match/${ev.id}`,
        });
      } catch { continue; }
    }
    return results;
  } catch { return []; }
}

// ─── Betclic (simple HTML parse without cheerio) ──────────────────────────────
const BETCLIC_BASE = 'https://www.betclic.ci';
const BETCLIC_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'fr-FR,fr;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,*/*',
};

function parseOdd(text) {
  if (!text) return null;
  const f = parseFloat(text.trim().replace(',', '.'));
  return isNaN(f) ? null : f;
}

function parseBetclicHtml(html) {
  const results = [];
  const todayIso = today();
  const tomorrowIso = tomorrow();

  // Extract cards with basic regex - look for cardEvent links
  const cardRe = /<a[^>]+class="[^"]*cardEvent[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let cardMatch;
  while ((cardMatch = cardRe.exec(html)) !== null) {
    try {
      const href = cardMatch[1];
      const cardHtml = cardMatch[2];
      const isLive = cardMatch[0].includes('is-live');

      // Match ID
      const midM = href.match(/-m(\d+)/);
      const mid = 'bc_' + (midM ? midM[1] : href);

      // Teams
      const homeM = cardHtml.match(/data-qa="contestant-1-label"[^>]*>([\s\S]*?)<\/div>/);
      const awayM = cardHtml.match(/data-qa="contestant-2-label"[^>]*>([\s\S]*?)<\/div>/);
      const home = homeM ? homeM[1].replace(/<[^>]+>/g, '').trim() : '';
      const away = awayM ? awayM[1].replace(/<[^>]+>/g, '').trim() : '';
      if (!home || !away) continue;

      // Time
      let timeStr = '';
      const timeM = cardHtml.match(/(\d{1,2}:\d{2})/);
      if (timeM) timeStr = timeM[1];

      // Score
      let score = null;
      const scoreM = cardHtml.match(/data-qa="scoreboard-score"[^>]*>([\s\S]*?)<\/div>/);
      if (scoreM && isLive) {
        const nums = scoreM[1].match(/\d+/g);
        if (nums && nums.length >= 2) score = { home: nums[0], away: nums[1] };
      }

      // Odds (look for odd values like "1.50", "2.30" etc)
      const oddMatches = [...cardHtml.matchAll(/class="[^"]*is-odd[^"]*"[\s\S]*?(\d+[.,]\d+)/g)];
      const odds = { '1': null, X: null, '2': null };
      if (oddMatches.length >= 1) odds['1'] = parseOdd(oddMatches[0][1]);
      if (oddMatches.length >= 2) odds['X'] = parseOdd(oddMatches[1][1]);
      if (oddMatches.length >= 3) odds['2'] = parseOdd(oddMatches[2][1]);

      // League from breadcrumb
      let league = '';
      const leagueM = cardHtml.match(/breadcrumb_itemLabel[^>]*>([\s\S]*?)<\/span>/g);
      if (leagueM && leagueM.length > 0) {
        league = leagueM[leagueM.length - 1].replace(/<[^>]+>/g, '').replace(/•/g, '').trim();
      }

      results.push({
        id: mid, source: 'betclic',
        league, home, away,
        time: timeStr,
        date: isLive ? todayIso : todayIso,
        minute: null, score,
        status: isLive ? 'live' : 'upcoming',
        odds,
        url: BETCLIC_BASE + href,
      });
    } catch { continue; }
  }
  return results;
}

const BETCLIC_PAGES = [
  '/football-sfootball',
  '/football-sfootball/top-football-europeen-p0',
  '/football-sfootball/espagne-laliga-c7',
  '/football-sfootball/angl-premier-league-c3',
  '/football-sfootball/ligue-1-mcdonald-s-c4',
  '/football-sfootball/italie-serie-a-c6',
  '/football-sfootball/football-champions-league-c2',
];

async function fetchBetclic() {
  const seen = new Set();
  const results = [];
  await Promise.allSettled(BETCLIC_PAGES.map(async (path) => {
    try {
      const { status, body } = await fetchUrl(BETCLIC_BASE + path, BETCLIC_HEADERS);
      if (status === 200) {
        for (const m of parseBetclicHtml(body)) {
          if (!seen.has(m.id)) { seen.add(m.id); results.push(m); }
        }
      }
    } catch { }
  }));
  return results;
}

// ─── Name normalization & dedup ───────────────────────────────────────────────
function normName(name) {
  let n = name.toLowerCase();
  for (const s of ['fc', 'sc', 'ac', 'cf', 'rc', 'fk', 'sk', 'bk', 'as', 'ss', 'cd', 'sd', 'ud']) {
    n = n.replace(new RegExp(`\\b${s}\\b`, 'g'), '');
  }
  const map = { é:'e',è:'e',ê:'e',ë:'e',à:'a',â:'a',ô:'o',ù:'u',û:'u',ü:'u',î:'i',ï:'i',ç:'c' };
  for (const [a, b] of Object.entries(map)) n = n.replace(new RegExp(a, 'g'), b);
  return n.replace(/[^a-z0-9]/g, '');
}
function matchKey(m) {
  return `${normName(m.home).slice(0,8)}|${normName(m.away).slice(0,8)}|${m.date}`;
}

// ─── Main aggregation ─────────────────────────────────────────────────────────
async function getMatches() {
  const td = today(), tm = tomorrow();
  const [betclicMatches, sofaToday, sofaTomorrow] = await Promise.all([
    fetchBetclic(),
    fetchSofascore(td),
    fetchSofascore(tm),
  ]);
  const sofascoreMatches = [...sofaToday, ...sofaTomorrow];

  const seenKeys = {};
  const all = [];

  function addMatches(list) {
    for (const m of list) {
      const k = matchKey(m);
      if (k in seenKeys) {
        const ex = all[seenKeys[k]];
        if (!ex.odds['1'] && m.odds['1']) ex.odds = m.odds;
        if (!ex.score && m.score) ex.score = m.score;
        if (!ex.minute && m.minute) ex.minute = m.minute;
        if (m.status === 'live') ex.status = 'live';
        if (!ex.sources) ex.sources = [ex.source];
        if (!ex.sources.includes(m.source)) ex.sources.push(m.source);
      } else {
        m.sources = [m.source];
        seenKeys[k] = all.length;
        all.push(m);
      }
    }
  }

  addMatches(betclicMatches);
  addMatches(sofascoreMatches);

  const filtered = all.filter(m => [td, tm].includes(m.date) && ['live', 'upcoming'].includes(m.status));
  filtered.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'live' ? -1 : 1;
    return (a.date + a.time).localeCompare(b.date + b.time);
  });

  return {
    ok: true,
    matches: filtered,
    count: filtered.length,
    sources: { betclic: betclicMatches.length, sofascore: sofascoreMatches.length },
  };
}

// ─── Static file server ───────────────────────────────────────────────────────
const fs = require('fs');
const pathMod = require('path');
const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res) {
  const urlPath = req.url.split('?')[0];
  const filePath = pathMod.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
  const ext = pathMod.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const urlPath = req.url.split('?')[0];

  if (urlPath === '/api/matches') {
    try {
      const data = await getMatches();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message, matches: [] }));
    }
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, () => {
  console.log(`AretSport dev server → http://localhost:${PORT}  [static + API]`);
});
