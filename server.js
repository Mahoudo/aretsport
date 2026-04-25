/**
 * AretSport Dev Server — ESPN + Betclic
 * Sert les fichiers statiques + /api/matches
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const pathMod = require('path');
const PORT = parseInt(process.env.PORT || '8090');
const ROOT = __dirname;

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
function today() { return new Date().toISOString().slice(0, 10); }
function tomorrow() { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); }
function toDateStr(d) { return d.toISOString().slice(0, 10); }

// ─── ESPN API ─────────────────────────────────────────────────────────────────
const ESPN_LEAGUES = [
  'eng.1', 'esp.1', 'ger.1', 'fra.1', 'ita.1', 'por.1', 'ned.1', 'tur.1',
  'bel.1', 'sco.1', 'usa.1', 'bra.1', 'arg.1', 'mex.1', 'afr.nations',
  'conmebol.copa_libertadores', 'conmebol.copa_sudamericana',
  'uefa.champions_league', 'uefa.europa', 'uefa.europa.conf_league',
];

const ESPN_STATUS_MAP = {
  'STATUS_SCHEDULED': 'upcoming',
  'STATUS_IN_PROGRESS': 'live',
  'STATUS_FINAL': 'finished',
  'STATUS_POSTPONED': 'postponed',
  'STATUS_CANCELED': 'canceled',
  'STATUS_HALFTIME': 'live',
};

async function fetchESPNLeague(league, dateStr) {
  const compact = dateStr.replace(/-/g, '');
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard?dates=${compact}&limit=100`;
  try {
    const { status, body } = await fetchUrl(url, {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/json',
    });
    if (status !== 200) return [];
    const data = JSON.parse(body);
    const events = data.events || [];
    const results = [];

    for (const ev of events) {
      try {
        const comp = ev.competitions?.[0];
        if (!comp) continue;
        const competitors = comp.competitors || [];
        const home = competitors.find(c => c.homeAway === 'home');
        const away = competitors.find(c => c.homeAway === 'away');
        if (!home || !away) continue;

        const homeName = home.team?.displayName || home.team?.name || '';
        const awayName = away.team?.displayName || away.team?.name || '';
        if (!homeName || !awayName) continue;

        const leagueName = data.leagues?.[0]?.name || league;
        const statusType = comp.status?.type?.name || 'STATUS_SCHEDULED';
        const matchStatus = ESPN_STATUS_MAP[statusType] || 'upcoming';

        const dateObj = new Date(ev.date);
        const matchDate = toDateStr(dateObj);
        const hh = String(dateObj.getUTCHours()).padStart(2, '0');
        const mm = String(dateObj.getUTCMinutes()).padStart(2, '0');
        const timeStr = `${hh}:${mm}`;

        let score = null, minute = null, stoppage = null;
        if (matchStatus === 'live' || matchStatus === 'finished') {
          const hs = home.score, as_ = away.score;
          if (hs != null && as_ != null) score = { home: String(hs), away: String(as_) };
          if (matchStatus === 'live') {
            const clock = comp.status?.displayClock || '';
            if (clock === 'HT') { minute = 45; }
            else {
              const parts = clock.match(/(\d+)(?:'\+(\d+)'?)?/);
              if (parts) { minute = parseInt(parts[1]); if (parts[2]) stoppage = parseInt(parts[2]); }
            }
          }
        }

        results.push({
          id: `espn_${ev.id}`,
          source: 'espn',
          league: leagueName,
          home: homeName,
          away: awayName,
          time: timeStr,
          date: matchDate,
          minute, stoppage, score,
          status: matchStatus,
          odds: { '1': null, X: null, '2': null },
          url: ev.links?.[0]?.href || `https://www.espn.com/soccer/match/_/gameId/${ev.id}`,
        });
      } catch { continue; }
    }
    return results;
  } catch { return []; }
}

async function fetchESPN(dateStr) {
  const results = await Promise.allSettled(ESPN_LEAGUES.map(l => fetchESPNLeague(l, dateStr)));
  const seen = new Set();
  const all = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      for (const m of r.value) {
        if (!seen.has(m.id)) { seen.add(m.id); all.push(m); }
      }
    }
  }
  return all;
}

// ─── Betclic (HTML scraping) ──────────────────────────────────────────────────
const BETCLIC_BASE = 'https://www.betclic.ci';
const BETCLIC_PAGES = [
  '/football-sfootball',
  '/football-sfootball/top-football-europeen-p0',
  '/football-sfootball/espagne-laliga-c7',
  '/football-sfootball/angl-premier-league-c3',
  '/football-sfootball/ligue-1-mcdonald-s-c4',
  '/football-sfootball/italie-serie-a-c6',
  '/football-sfootball/football-champions-league-c2',
  '/football-sfootball/allemagne-bundesliga-c5',
];
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
  const cardRe = /<a[^>]+class="[^"]*cardEvent[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let cardMatch;
  while ((cardMatch = cardRe.exec(html)) !== null) {
    try {
      const href = cardMatch[1];
      const cardHtml = cardMatch[2];
      const isLive = cardMatch[0].includes('is-live');
      const midM = href.match(/-m(\d+)/);
      const mid = 'bc_' + (midM ? midM[1] : href);
      const homeM = cardHtml.match(/data-qa="contestant-1-label"[^>]*>([\s\S]*?)<\/div>/);
      const awayM = cardHtml.match(/data-qa="contestant-2-label"[^>]*>([\s\S]*?)<\/div>/);
      const home = homeM ? homeM[1].replace(/<[^>]+>/g, '').trim() : '';
      const away = awayM ? awayM[1].replace(/<[^>]+>/g, '').trim() : '';
      if (!home || !away) continue;
      const timeM = cardHtml.match(/(\d{1,2}:\d{2})/);
      const timeStr = timeM ? timeM[1] : '';
      let score = null;
      if (isLive) {
        const sM = cardHtml.match(/data-qa="scoreboard-score"[^>]*>([\s\S]*?)<\/div>/);
        if (sM) { const nums = sM[1].match(/\d+/g); if (nums?.length >= 2) score = { home: nums[0], away: nums[1] }; }
      }
      const oddMs = [...cardHtml.matchAll(/class="[^"]*is-odd[^"]*"[\s\S]*?(\d+[.,]\d+)/g)];
      const odds = { '1': null, X: null, '2': null };
      if (oddMs[0]) odds['1'] = parseOdd(oddMs[0][1]);
      if (oddMs[1]) odds['X'] = parseOdd(oddMs[1][1]);
      if (oddMs[2]) odds['2'] = parseOdd(oddMs[2][1]);
      const leagueMs = [...cardHtml.matchAll(/<[^>]*breadcrumb_itemLabel[^>]*>([\s\S]*?)<\/span>/g)];
      const league = leagueMs.length ? leagueMs[leagueMs.length - 1][1].replace(/<[^>]+>/g, '').replace(/•/g, '').trim() : '';
      results.push({ id: mid, source: 'betclic', league, home, away, time: timeStr, date: todayIso, minute: null, stoppage: null, score, status: isLive ? 'live' : 'upcoming', odds, url: BETCLIC_BASE + href });
    } catch { continue; }
  }
  return results;
}

async function fetchBetclic() {
  const seen = new Set(), results = [];
  await Promise.allSettled(BETCLIC_PAGES.map(async (path) => {
    try {
      const { status, body } = await fetchUrl(BETCLIC_BASE + path, BETCLIC_HEADERS);
      if (status === 200) {
        for (const m of parseBetclicHtml(body)) {
          if (!seen.has(m.id)) { seen.add(m.id); results.push(m); }
        }
      }
    } catch {}
  }));
  return results;
}

// ─── Name normalization & dedup ───────────────────────────────────────────────
function normName(name) {
  let n = name.toLowerCase();
  for (const s of ['fc','sc','ac','cf','rc','fk','sk','bk','as','ss','cd','sd','ud']) {
    n = n.replace(new RegExp(`\\b${s}\\b`, 'g'), '');
  }
  const map = { é:'e',è:'e',ê:'e',ë:'e',à:'a',â:'a',ô:'o',ù:'u',û:'u',ü:'u',î:'i',ï:'i',ç:'c' };
  for (const [a, b] of Object.entries(map)) n = n.replace(new RegExp(a, 'g'), b);
  return n.replace(/[^a-z0-9]/g, '');
}
function matchKey(m) { return `${normName(m.home).slice(0,8)}|${normName(m.away).slice(0,8)}|${m.date}`; }

// ─── Main aggregation ─────────────────────────────────────────────────────────
async function getMatches() {
  const td = today(), tm = tomorrow();
  const [betclicMatches, espnToday, espnTomorrow] = await Promise.all([
    fetchBetclic(),
    fetchESPN(td),
    fetchESPN(tm),
  ]);
  const espnAll = [...espnToday, ...espnTomorrow];

  const seenKeys = {}, all = [];

  function addMatches(list) {
    for (const m of list) {
      const k = matchKey(m);
      if (k in seenKeys) {
        const ex = all[seenKeys[k]];
        if (!ex.odds['1'] && m.odds['1']) ex.odds = m.odds;
        if (!ex.score && m.score) ex.score = m.score;
        if (ex.minute == null && m.minute != null) ex.minute = m.minute;
        if (ex.stoppage == null && m.stoppage != null) ex.stoppage = m.stoppage;
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

  addMatches(betclicMatches);  // betclic en priorité (a les cotes)
  addMatches(espnAll);         // ESPN complète avec tous les matchs

  const filtered = all
    .filter(m => [td, tm].includes(m.date) && ['live', 'upcoming'].includes(m.status))
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'live' ? -1 : 1;
      return (a.date + a.time).localeCompare(b.date + b.time);
    });

  return {
    ok: true,
    matches: filtered,
    count: filtered.length,
    sources: { betclic: betclicMatches.length, espn: espnAll.length },
  };
}

// ─── Static file server ───────────────────────────────────────────────────────
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
  console.log(`AretSport dev server → http://localhost:${PORT}  [ESPN + Betclic]`);
});
