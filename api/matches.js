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
function tsToTimeAndDate(ts) {
  const d = new Date(ts * 1000);
  return {
    time: `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`,
    date: d.toISOString().slice(0, 10)
  };
}

const SOFA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.sofascore.com/',
};
const STATUS_MAP = { notstarted:'upcoming', inprogress:'live', finished:'finished', postponed:'postponed', canceled:'canceled' };

async function fetchSofascore(dateStr) {
  try {
    const { status, body } = await fetchUrl(
      `https://api.sofascore.com/api/v1/sport/football/scheduled-events/${dateStr}`,
      SOFA_HEADERS
    );
    if (status !== 200) return [];
    const events = JSON.parse(body).events || [];
    return events.map(ev => {
      try {
        const home = ev.homeTeam?.name || '';
        const away = ev.awayTeam?.name || '';
        if (!home || !away) return null;
        let league = ev.tournament?.name || '';
        const cat = ev.tournament?.category?.name || '';
        if (cat && !league.includes(cat)) league = `${cat} • ${league}`;
        const { time, date } = ev.startTimestamp ? tsToTimeAndDate(ev.startTimestamp) : { time: '', date: dateStr };
        const matchStatus = STATUS_MAP[ev.status?.type] || 'upcoming';
        let score = null, minute = null;
        if (['live','finished'].includes(matchStatus)) {
          const hc = ev.homeScore?.current, ac = ev.awayScore?.current;
          if (hc != null && ac != null) score = { home: String(hc), away: String(ac) };
          if (matchStatus === 'live' && ev.time?.currentPeriodStartTimestamp)
            minute = Math.min(Math.floor((Date.now()/1000 - ev.time.currentPeriodStartTimestamp)/60), 90);
        }
        return { id:`ss_${ev.id}`, source:'sofascore', league, home, away, time, date, minute, score, status:matchStatus, odds:{'1':null,X:null,'2':null}, url:`https://www.sofascore.com/match/${ev.id}` };
      } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

const BETCLIC_BASE = 'https://www.betclic.ci';
const BETCLIC_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'fr-FR,fr;q=0.9',
  'Accept': 'text/html,*/*',
};

function parseOdd(t) { if (!t) return null; const f = parseFloat(t.trim().replace(',','.')); return isNaN(f)?null:f; }

function parseBetclicHtml(html) {
  const results = [], todayIso = today();
  const cardRe = /<a[^>]+class="[^"]*cardEvent[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = cardRe.exec(html)) !== null) {
    try {
      const href = m[1], cardHtml = m[2], isLive = m[0].includes('is-live');
      const midM = href.match(/-m(\d+)/);
      const mid = 'bc_' + (midM ? midM[1] : href);
      const homeM = cardHtml.match(/data-qa="contestant-1-label"[^>]*>([\s\S]*?)<\/div>/);
      const awayM = cardHtml.match(/data-qa="contestant-2-label"[^>]*>([\s\S]*?)<\/div>/);
      const home = homeM ? homeM[1].replace(/<[^>]+>/g,'').trim() : '';
      const away = awayM ? awayM[1].replace(/<[^>]+>/g,'').trim() : '';
      if (!home || !away) continue;
      const timeM = cardHtml.match(/(\d{1,2}:\d{2})/);
      const timeStr = timeM ? timeM[1] : '';
      let score = null;
      if (isLive) {
        const sM = cardHtml.match(/data-qa="scoreboard-score"[^>]*>([\s\S]*?)<\/div>/);
        if (sM) { const nums = sM[1].match(/\d+/g); if (nums?.length >= 2) score = { home:nums[0], away:nums[1] }; }
      }
      const oddMatches = [...cardHtml.matchAll(/class="[^"]*is-odd[^"]*"[\s\S]*?(\d+[.,]\d+)/g)];
      const odds = {'1':null,X:null,'2':null};
      if (oddMatches[0]) odds['1'] = parseOdd(oddMatches[0][1]);
      if (oddMatches[1]) odds['X'] = parseOdd(oddMatches[1][1]);
      if (oddMatches[2]) odds['2'] = parseOdd(oddMatches[2][1]);
      const leagueMs = [...cardHtml.matchAll(/breadcrumb_itemLabel[^>]*>([\s\S]*?)<\/span>/g)];
      const league = leagueMs.length ? leagueMs[leagueMs.length-1][1].replace(/<[^>]+>/g,'').replace(/•/g,'').trim() : '';
      results.push({ id:mid, source:'betclic', league, home, away, time:timeStr, date:todayIso, minute:null, score, status:isLive?'live':'upcoming', odds, url:BETCLIC_BASE+href });
    } catch { continue; }
  }
  return results;
}

async function fetchBetclic() {
  const pages = ['/football-sfootball','/football-sfootball/top-football-europeen-p0','/football-sfootball/espagne-laliga-c7','/football-sfootball/angl-premier-league-c3','/football-sfootball/ligue-1-mcdonald-s-c4','/football-sfootball/italie-serie-a-c6','/football-sfootball/football-champions-league-c2'];
  const seen = new Set(), results = [];
  await Promise.allSettled(pages.map(async p => {
    try {
      const { status, body } = await fetchUrl(BETCLIC_BASE + p, BETCLIC_HEADERS);
      if (status === 200) for (const m of parseBetclicHtml(body)) if (!seen.has(m.id)) { seen.add(m.id); results.push(m); }
    } catch {}
  }));
  return results;
}

function normName(n) {
  let s = n.toLowerCase();
  for (const x of ['fc','sc','ac','cf','rc','fk','bk','as','ss','cd','sd','ud']) s = s.replace(new RegExp(`\\b${x}\\b`,'g'),'');
  const map = {é:'e',è:'e',ê:'e',à:'a',â:'a',ô:'o',ù:'u',û:'u',î:'i',ç:'c'};
  for (const [a,b] of Object.entries(map)) s = s.replace(new RegExp(a,'g'),b);
  return s.replace(/[^a-z0-9]/g,'');
}
function matchKey(m) { return `${normName(m.home).slice(0,8)}|${normName(m.away).slice(0,8)}|${m.date}`; }

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    const td = today(), tm = tomorrow();
    const [betclic, sofaTd, sofaTm] = await Promise.all([fetchBetclic(), fetchSofascore(td), fetchSofascore(tm)]);
    const sofascore = [...sofaTd, ...sofaTm];
    const seenKeys = {}, all = [];

    function add(list) {
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
    add(betclic); add(sofascore);

    const filtered = all
      .filter(m => [td,tm].includes(m.date) && ['live','upcoming'].includes(m.status))
      .sort((a,b) => {
        if (a.status !== b.status) return a.status==='live'?-1:1;
        return (a.date+a.time).localeCompare(b.date+b.time);
      });

    res.status(200).json({ ok:true, matches:filtered, count:filtered.length, sources:{betclic:betclic.length, sofascore:sofascore.length} });
  } catch(e) {
    res.status(500).json({ ok:false, error:e.message, matches:[] });
  }
};
