const https = require('https');
const http = require('http');

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

function today() { return new Date().toISOString().slice(0, 10); }
function tomorrow() { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); }

// ─── ESPN API ─────────────────────────────────────────────────────────────────
const ESPN_LEAGUES = [
  // Europe Top 5
  'eng.1', 'esp.1', 'ger.1', 'fra.1', 'ita.1',
  // Europe 2e division
  'eng.2', 'esp.2', 'ger.2', 'fra.2', 'ita.2',
  // Europe autres
  'por.1', 'ned.1', 'bel.1', 'tur.1', 'sco.1',
  'aut.1', 'che.1', 'grc.1', 'swe.1', 'nor.1',
  'dnk.1', 'pol.1', 'cze.1', 'svk.1', 'hrv.1',
  'rom.1', 'hun.1', 'srb.1', 'ukr.1', 'isr.1',
  'cyp.1', 'svn.1', 'bih.1', 'alb.1', 'mkd.1',
  // Coupes Europe
  'uefa.champions_league', 'uefa.europa', 'uefa.europa.conf_league',
  // Amériques
  'usa.1', 'bra.1', 'arg.1', 'mex.1', 'col.1',
  'chi.1', 'uru.1', 'ecu.1', 'per.1', 'par.1',
  'bol.1', 'ven.1',
  'conmebol.copa_libertadores', 'conmebol.copa_sudamericana',
  // Afrique & Moyen-Orient
  'afr.nations', 'sau.1', 'are.1', 'egy.1', 'mar.1',
  'zaf.1', 'tun.1', 'nga.1',
  // Asie-Pacifique
  'jpn.1', 'jpn.2', 'kor.1', 'chn.1', 'aus.1', 'ind.1',
  // Qualifs
  'fifa.worldq.afc', 'fifa.worldq.caf',
  'fifa.worldq.conmebol', 'fifa.worldq.concacaf', 'fifa.worldq.uefa',
  // CONCACAF
  'concacaf.champions', 'concacaf.league',
];

const ESPN_STATUS_MAP = {
  'STATUS_SCHEDULED':   'upcoming',
  'STATUS_IN_PROGRESS': 'live',
  'STATUS_FIRST_HALF':  'live',
  'STATUS_SECOND_HALF': 'live',
  'STATUS_HALFTIME':    'live',
  'STATUS_EXTRA_TIME':  'live',
  'STATUS_PENALTIES':   'live',
  'STATUS_FINAL':       'finished',
  'STATUS_FULL_TIME':   'finished',
  'STATUS_FULL_PEN':    'finished',
  'STATUS_ABANDONED':   'canceled',
  'STATUS_POSTPONED':   'postponed',
  'STATUS_CANCELED':    'canceled',
  'STATUS_SUSPENDED':   'postponed',
};

async function fetchESPNLeague(league, dateStr) {
  const compact = dateStr.replace(/-/g, '');
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard?dates=${compact}&limit=100`;
  try {
    const { status, body } = await fetchUrl(url, {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/json',
    }, 10000);
    if (status !== 200) return [];
    const data = JSON.parse(body);
    const results = [];
    for (const ev of (data.events || [])) {
      try {
        const comp = ev.competitions?.[0];
        if (!comp) continue;
        const competitors = comp.competitors || [];
        const home = competitors.find(c => c.homeAway === 'home');
        const away = competitors.find(c => c.homeAway === 'away');
        if (!home || !away) continue;
        const leagueName = data.leagues?.[0]?.name || league;
        const statusType = comp.status?.type?.name || 'STATUS_SCHEDULED';
        const matchStatus = ESPN_STATUS_MAP[statusType] || 'upcoming';
        // Si ESPN ne fournit pas de date → ignorer ce match (évite les faux positifs sur aujourd'hui)
        if (!ev.date) continue;
        const dateStr2 = ev.date.slice(0, 10);
        // Vérifier que la date du match correspond bien à la date demandée
        if (dateStr2 !== dateStr) continue;
        const timeObj = new Date(ev.date);
        const timeStr = timeObj.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Abidjan' });
        let score = null, minute = null, stoppage = null;
        if (matchStatus === 'live' || matchStatus === 'finished') {
          const hs = home.score, as_ = away.score;
          if (hs != null && as_ != null) score = { home: String(hs), away: String(as_) };
          if (matchStatus === 'live') {
            const clock = comp.status?.displayClock || '';
            if (clock === 'HT') { minute = 45; }
            else {
              const parts = clock.match(/^(\d+)(?:\:(\d+))?$/);
              if (parts) { minute = parseInt(parts[1]); }
            }
          }
        }
        results.push({
          id: `espn_${ev.id}`,
          source: 'espn',
          league: leagueName,
          home: home.team?.displayName || home.team?.name || '',
          away: away.team?.displayName || away.team?.name || '',
          homeLogo: home.team?.logo || null,
          awayLogo: away.team?.logo || null,
          time: timeStr,
          date: dateStr2,
          minute, stoppage, score,
          status: matchStatus,
          odds: { '1': null, X: null, '2': null },
          url: null,
        });
      } catch { continue; }
    }
    return results;
  } catch { return []; }
}

async function fetchESPN(dateStr) {
  // Fetch all leagues in parallel, by batches of 15 to avoid overwhelming
  const BATCH = 15;
  const all = [];
  for (let i = 0; i < ESPN_LEAGUES.length; i += BATCH) {
    const batch = ESPN_LEAGUES.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map(l => fetchESPNLeague(l, dateStr)));
    for (const r of results) if (r.status === 'fulfilled') all.push(...r.value);
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
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
  'Accept-Language': 'fr-FR,fr;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,*/*',
};

function parseOdd(t) {
  if (!t) return null;
  const f = parseFloat(t.trim().replace(',', '.'));
  return isNaN(f) ? null : f;
}

function parseBetclicHtml(html) {
  const results = [], todayIso = today();
  const cardRe = /<a[^>]+class="[^"]*cardEvent[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = cardRe.exec(html)) !== null) {
    try {
      const href = m[1], cardHtml = m[2], isLive = m[0].includes('is-live');
      const midM = href.match(/-m(\d+)/);
      if (!midM) continue;
      const mid = 'bc_' + midM[1];
      const homeM = cardHtml.match(/data-qa="contestant-1-label"[^>]*>([\s\S]*?)<\/div>/);
      const awayM = cardHtml.match(/data-qa="contestant-2-label"[^>]*>([\s\S]*?)<\/div>/);
      const home = homeM ? homeM[1].replace(/<[^>]+>/g, '').trim() : '';
      const away = awayM ? awayM[1].replace(/<[^>]+>/g, '').trim() : '';
      if (!home || !away) continue;
      const timeM = cardHtml.match(/(\d{1,2}:\d{2})/);
      const timeStr = timeM ? timeM[1] : '';
      let score = null, minute = null, stoppage = null, half = null;
      if (isLive) {
        // Score — cibler scoreboard_score-1 et scoreboard_score-2 directement
        const sH = cardHtml.match(/scoreboard_score-1[^>]*>(\d+)/);
        const sA = cardHtml.match(/scoreboard_score-2[^>]*>(\d+)/);
        if (sH && sA) {
          score = { home: sH[1], away: sA[1] };
        } else {
          const sM = cardHtml.match(/data-qa="scoreboard-score"[^>]*>([\s\S]*?)<\/span>\s*<\/span>/);
          if (sM) { const nums = sM[1].match(/\d+/g); if (nums?.length >= 2) score = { home: nums[0], away: nums[1] }; }
        }
        // Minute depuis scoreboards-timer : "36' • MT 1" ou "45+2' • MT 1"
        const timerM = cardHtml.match(/scoreboards-timer[^>]*>[\s\S]*?(\d{1,3})(?:\+(\d+))?'\s*(?:•\s*(MT\s*\d|[A-Z\-]+))?/);
        if (timerM) {
          minute = parseInt(timerM[1]);
          if (timerM[2]) stoppage = parseInt(timerM[2]);
          half = timerM[3] ? timerM[3].trim() : null;
        } else if (/scoreboards-timer[^>]*>[\s\S]*?(HT|MI.TEMPS|HALFTIME)/i.test(cardHtml)) {
          minute = 45; half = 'HT';
        }
      }
      const oddMs = [...cardHtml.matchAll(/class="[^"]*is-odd[^"]*"[\s\S]*?(\d+[.,]\d+)/g)];
      const odds = { '1': null, X: null, '2': null };
      if (oddMs[0]) odds['1'] = parseOdd(oddMs[0][1]);
      if (oddMs[1]) odds['X'] = parseOdd(oddMs[1][1]);
      if (oddMs[2]) odds['2'] = parseOdd(oddMs[2][1]);
      const leagueMs = [...cardHtml.matchAll(/<[^>]*breadcrumb_itemLabel[^>]*>([\s\S]*?)<\/span>/g)];
      const league = leagueMs.length ? leagueMs[leagueMs.length - 1][1].replace(/<[^>]+>/g, '').replace(/•/g, '').trim() : '';
      results.push({ id: mid, source: 'betclic', league, home, away, time: timeStr, date: todayIso, minute, stoppage, half, score, status: isLive ? 'live' : 'upcoming', odds, url: BETCLIC_BASE + href });
    } catch { continue; }
  }
  return results;
}

async function fetchBetclic() {
  const seen = new Set(), results = [];
  await Promise.allSettled(BETCLIC_PAGES.map(async p => {
    try {
      const { status, body } = await fetchUrl(BETCLIC_BASE + p, BETCLIC_HEADERS, 12000);
      if (status === 200) for (const m of parseBetclicHtml(body)) if (!seen.has(m.id)) { seen.add(m.id); results.push(m); }
    } catch {}
  }));
  return results;
}

// ─── Name normalization ───────────────────────────────────────────────────────
function normName(n) {
  let s = n.toLowerCase();
  for (const x of ['fc','sc','ac','cf','rc','fk','sk','bk','as','ss','cd','sd','ud']) s = s.replace(new RegExp(`\\b${x}\\b`, 'g'), '');
  const map = { é:'e',è:'e',ê:'e',ë:'e',à:'a',â:'a',ô:'o',ù:'u',û:'u',ü:'u',î:'i',ï:'i',ç:'c' };
  for (const [a, b] of Object.entries(map)) s = s.replace(new RegExp(a, 'g'), b);
  return s.replace(/[^a-z0-9]/g, '');
}
function matchKey(m) { return `${normName(m.home).slice(0,8)}|${normName(m.away).slice(0,8)}|${m.date}`; }

// ─── Cache simple (30s) ───────────────────────────────────────────────────────
let _cache = null, _cacheTs = 0;
const CACHE_TTL = 30000;

// ─── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // Renvoyer le cache si récent
  if (_cache && Date.now() - _cacheTs < CACHE_TTL) {
    return res.status(200).json(_cache);
  }

  try {
    const td = today(), tm = tomorrow();
    const [betclic, espnToday, espnTomorrow] = await Promise.all([
      fetchBetclic(),
      fetchESPN(td),
      fetchESPN(tm),
    ]);
    const espnAll = [...espnToday, ...espnTomorrow];

    const seenKeys = {}, all = [];
    function add(list) {
      for (const m of list) {
        const k = matchKey(m);
        if (k in seenKeys) {
          const ex = all[seenKeys[k]];
          if (!ex.odds?.['1'] && m.odds?.['1']) ex.odds = m.odds;
          if (!ex.score && m.score) ex.score = m.score;
          if (ex.minute == null && m.minute != null) ex.minute = m.minute;
          if (ex.stoppage == null && m.stoppage != null) ex.stoppage = m.stoppage;
          if (!ex.half && m.half) ex.half = m.half;
          if (m.status === 'live') ex.status = 'live';
          if (!ex.homeLogo && m.homeLogo) ex.homeLogo = m.homeLogo;
          if (!ex.awayLogo && m.awayLogo) ex.awayLogo = m.awayLogo;
          ex.sources = ex.sources || [ex.source];
          if (!ex.sources.includes(m.source)) ex.sources.push(m.source);
        } else {
          m.sources = [m.source];
          seenKeys[k] = all.length;
          all.push(m);
        }
      }
    }
    add(betclic);
    add(espnAll);

    const filtered = all
      .filter(m => [td, tm].includes(m.date) && ['live', 'upcoming'].includes(m.status))
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === 'live' ? -1 : 1;
        return (a.date + (a.time || '')).localeCompare(b.date + (b.time || ''));
      });

    const payload = {
      ok: true,
      matches: filtered,
      count: filtered.length,
      sources: { betclic: betclic.length, espn: espnAll.length },
    };
    _cache = payload;
    _cacheTs = Date.now();
    res.status(200).json(payload);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, matches: [] });
  }
};
