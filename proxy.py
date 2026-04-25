#!/usr/bin/env python3
"""Proxy server: serves static files + /api/matches aggregated from multiple bookmakers"""

import json, re, os, sys, datetime
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests
from bs4 import BeautifulSoup

MONTH_MAP = {
    'jan':1,'fév':2,'fev':2,'mar':3,'avr':4,'mai':5,'jun':6,
    'juil':7,'jul':7,'aoû':8,'aou':8,'sep':9,'oct':10,'nov':11,'déc':12,'dec':12
}

def parse_date_from_time(time_str):
    if not time_str:
        return None
    m = re.search(r'(\d{1,2})\s+([a-záéûô]+)', time_str.lower())
    if m:
        day = int(m.group(1))
        month_key = m.group(2)[:4]
        month = MONTH_MAP.get(month_key) or MONTH_MAP.get(month_key[:3])
        if month:
            year = datetime.date.today().year
            try:
                d = datetime.date(year, month, day)
                if (d - datetime.date.today()).days < -30:
                    d = datetime.date(year + 1, month, day)
                return d.isoformat()
            except:
                pass
    return None

PORT = 8090

# ─── Betclic ────────────────────────────────────────────────────────────────
BETCLIC_BASE = "https://www.betclic.ci"
HEADERS_DESKTOP = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "fr-FR,fr;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

BETCLIC_PAGES = [
    "/football-sfootball",
    "/football-sfootball/top-football-europeen-p0",
    "/football-sfootball/espagne-laliga-c7",
    "/football-sfootball/allemagne-bundesliga-c5",
    "/football-sfootball/angl-premier-league-c3",
    "/football-sfootball/ligue-1-mcdonald-s-c4",
    "/football-sfootball/italie-serie-a-c6",
    "/football-sfootball/football-champions-league-c2",
    "/football-sfootball/portugal-liga-portugal-c8",
    "/football-sfootball/pays-bas-eredivisie-c14",
]

def parse_odd(text):
    if not text:
        return None
    text = text.strip().replace(',', '.')
    try:
        return float(text)
    except:
        return None

def group_date_to_iso(text):
    today = datetime.date.today()
    t = text.strip().lower()
    if "aujourd" in t:
        return today.isoformat()
    if "demain" in t:
        return (today + datetime.timedelta(days=1)).isoformat()
    m = re.search(r'(\d{1,2})/(\d{2})', t)
    if m:
        day, month = int(m.group(1)), int(m.group(2))
        year = today.year
        try:
            d = datetime.date(year, month, day)
            if (d - today).days < -30:
                d = datetime.date(year + 1, month, day)
            return d.isoformat()
        except:
            pass
    return today.isoformat()

def parse_betclic_page(html):
    soup = BeautifulSoup(html, 'lxml')
    results = []
    today_iso = datetime.date.today().isoformat()

    card_date_map = {}
    for group in soup.find_all('div', class_='groupEvents'):
        head = group.find('div', class_='groupEvents_head')
        if not head:
            continue
        date_iso = group_date_to_iso(head.get_text(strip=True))
        for card in group.find_all('a', class_='cardEvent'):
            href = card.get('href', '')
            if href:
                card_date_map[href] = date_iso

    for card in soup.find_all('a', class_='cardEvent'):
        try:
            href = card.get('href', '')
            mid_match = re.search(r'-m(\d+)', href)
            mid = 'bc_' + (mid_match.group(1) if mid_match else href)
            is_live = 'is-live' in card.get('class', [])

            crumbs = card.find_all('bcdk-breadcrumb-item')
            league = ''
            for c in crumbs:
                lbl = c.find('span', class_='breadcrumb_itemLabel')
                if lbl:
                    t = lbl.get_text(strip=True)
                    if t:
                        league = t
            league = league.strip('• ').strip()

            home_el = card.find('div', attrs={'data-qa': 'contestant-1-label'})
            away_el = card.find('div', attrs={'data-qa': 'contestant-2-label'})
            home = home_el.get_text(strip=True) if home_el else ''
            away = away_el.get_text(strip=True) if away_el else ''

            score_el = card.find('div', attrs={'data-qa': 'scoreboard-score'})
            score = None
            if score_el:
                scores = score_el.find_all('span', class_=re.compile('scoreboard_score'))
                if len(scores) >= 2:
                    score = {'home': scores[0].get_text(strip=True), 'away': scores[1].get_text(strip=True)}

            timer_el = card.find('scoreboards-timer')
            time_str = ''
            minute = None
            if timer_el:
                t = timer_el.get_text(strip=True)
                m = re.search(r"(\d+)'", t)
                if m:
                    minute = int(m.group(1))
                    time_str = t
                else:
                    time_str = t

            if not is_live:
                time_el = card.find('div', class_='scoreboard_info')
                if time_el:
                    t = time_el.get_text(strip=True).rstrip('-').strip()
                    if re.match(r'\d{1,2}:\d{2}', t):
                        time_str = t
                if not time_str:
                    time_el2 = card.find(class_=re.compile('event_infoTime|eventTime|cardEvent_time'))
                    if time_el2:
                        time_str = time_el2.get_text(strip=True)

            btn_wrappers = card.find_all('button', class_=re.compile('btn.*is-odd'))
            odds_1 = odds_x = odds_2 = None
            labels = []
            for btn in btn_wrappers:
                all_lbls = btn.find_all('bcdk-bet-button-label')
                top_text = val_text = ''
                for lbl in all_lbls:
                    cls = lbl.get('class', [])
                    if 'is-top' in cls:
                        top_text = lbl.get_text(strip=True)
                    else:
                        val_text = lbl.get_text(strip=True)
                if top_text:
                    labels.append({'label': top_text, 'val': val_text})

            if len(labels) >= 1:
                odds_1 = parse_odd(labels[0]['val'])
            if len(labels) >= 2:
                if len(labels) >= 3:
                    odds_x = parse_odd(labels[1]['val'])
                    odds_2 = parse_odd(labels[2]['val'])
                else:
                    odds_2 = parse_odd(labels[1]['val'])

            if not home or not away:
                continue

            if is_live:
                match_date = today_iso
            else:
                match_date = card_date_map.get(href) or parse_date_from_time(time_str) or today_iso

            results.append({
                'id': mid,
                'source': 'betclic',
                'league': league,
                'home': home,
                'away': away,
                'time': time_str,
                'date': match_date,
                'minute': minute,
                'score': score,
                'status': 'live' if is_live else 'upcoming',
                'odds': {'1': odds_1, 'X': odds_x, '2': odds_2},
                'url': BETCLIC_BASE + href,
            })
        except Exception:
            continue

    return results


def fetch_betclic():
    results = []
    def fetch_page(path):
        try:
            r = requests.get(BETCLIC_BASE + path, headers=HEADERS_DESKTOP, timeout=12)
            return parse_betclic_page(r.text)
        except Exception:
            return []

    seen = set()
    with ThreadPoolExecutor(max_workers=len(BETCLIC_PAGES)) as ex:
        futures = {ex.submit(fetch_page, p): p for p in BETCLIC_PAGES}
        for fut in as_completed(futures):
            for m in fut.result():
                if m['id'] not in seen:
                    seen.add(m['id'])
                    results.append(m)
    return results


# ─── Sofascore ──────────────────────────────────────────────────────────────
SOFASCORE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "Referer": "https://www.sofascore.com/",
}

STATUS_MAP = {
    'notstarted': 'upcoming',
    'inprogress': 'live',
    'finished': 'finished',
    'postponed': 'postponed',
    'canceled': 'canceled',
}

def fetch_sofascore(date_str):
    """Fetch from Sofascore unofficial API for a given date (YYYY-MM-DD)"""
    url = f"https://api.sofascore.com/api/v1/sport/football/scheduled-events/{date_str}"
    try:
        r = requests.get(url, headers=SOFASCORE_HEADERS, timeout=12)
        if r.status_code != 200:
            return []
        data = r.json()
        events = data.get('events', [])
        results = []
        for ev in events:
            try:
                eid = 'ss_' + str(ev.get('id', ''))
                league = ev.get('tournament', {}).get('name', '')
                category = ev.get('tournament', {}).get('category', {}).get('name', '')
                if category and category not in league:
                    league = f"{category} • {league}"

                home = ev.get('homeTeam', {}).get('name', '')
                away = ev.get('awayTeam', {}).get('name', '')
                if not home or not away:
                    continue

                ts = ev.get('startTimestamp')
                time_str = ''
                match_date = date_str
                if ts:
                    dt = datetime.datetime.utcfromtimestamp(ts)
                    time_str = dt.strftime('%H:%M')
                    match_date = dt.date().isoformat()

                raw_status = ev.get('status', {}).get('type', 'notstarted')
                status = STATUS_MAP.get(raw_status, 'upcoming')

                minute = None
                score = None
                if status == 'live':
                    minute = ev.get('time', {}).get('currentPeriodStartTimestamp')
                    if minute:
                        elapsed = int((datetime.datetime.utcnow().timestamp() - minute) / 60)
                        minute = min(elapsed, 90)
                    hs = ev.get('homeScore', {})
                    as_ = ev.get('awayScore', {})
                    h_cur = hs.get('current')
                    a_cur = as_.get('current')
                    if h_cur is not None and a_cur is not None:
                        score = {'home': str(h_cur), 'away': str(a_cur)}
                elif status == 'finished':
                    hs = ev.get('homeScore', {})
                    as_ = ev.get('awayScore', {})
                    h_cur = hs.get('current')
                    a_cur = as_.get('current')
                    if h_cur is not None and a_cur is not None:
                        score = {'home': str(h_cur), 'away': str(a_cur)}

                results.append({
                    'id': eid,
                    'source': 'sofascore',
                    'league': league,
                    'home': home,
                    'away': away,
                    'time': time_str,
                    'date': match_date,
                    'minute': minute,
                    'score': score,
                    'status': status,
                    'odds': {'1': None, 'X': None, '2': None},
                    'url': f"https://www.sofascore.com/match/{ev.get('id', '')}",
                })
            except Exception:
                continue
        return results
    except Exception:
        return []


# ─── 1xBet ──────────────────────────────────────────────────────────────────
XBET_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "fr-FR,fr;q=0.9",
    "Referer": "https://1xbet.ci/",
    "Origin": "https://1xbet.ci",
}

def fetch_1xbet():
    """Fetch football line from 1xbet JSON API"""
    results = []
    try:
        # Live matches
        live_url = "https://1xbet.ci/LineFeed/GetGameZip?sports=1&chunkSize=50&lng=fr&isVirtual=false&GroupEvents=true&countryCode=CI"
        r = requests.get(live_url, headers=XBET_HEADERS, timeout=10)
        if r.status_code == 200:
            results += parse_1xbet_json(r.json(), 'live')
    except Exception:
        pass

    try:
        # Pre-match (today)
        line_url = "https://1xbet.ci/LineFeed/GetSportsLine?sport=1&chunkSize=50&lng=fr&country=0&partnerId=1&seriesId=0&isVirtual=false&GroupEvents=true"
        r = requests.get(line_url, headers=XBET_HEADERS, timeout=10)
        if r.status_code == 200:
            results += parse_1xbet_json(r.json(), 'upcoming')
    except Exception:
        pass

    return results


def parse_1xbet_json(data, default_status):
    results = []
    today = datetime.date.today().isoformat()
    tomorrow = (datetime.date.today() + datetime.timedelta(days=1)).isoformat()

    try:
        # 1xbet JSON structure: {"Value": [...leagues...]}
        leagues = data.get('Value', [])
        if not isinstance(leagues, list):
            # Sometimes wrapped differently
            if isinstance(data, dict):
                for v in data.values():
                    if isinstance(v, list) and len(v) > 0:
                        leagues = v
                        break

        for league_obj in leagues:
            league_name = league_obj.get('L', '') or league_obj.get('LN', '')
            events = league_obj.get('E', []) or league_obj.get('Events', [])
            for ev in events:
                try:
                    eid = '1x_' + str(ev.get('I', ev.get('Id', '')))
                    home = ev.get('O1', '') or ev.get('Team1', '')
                    away = ev.get('O2', '') or ev.get('Team2', '')
                    if not home or not away:
                        continue

                    ts = ev.get('S') or ev.get('StartTime')
                    time_str = ''
                    match_date = today
                    if ts:
                        try:
                            dt = datetime.datetime.utcfromtimestamp(int(ts))
                            time_str = dt.strftime('%H:%M')
                            match_date = dt.date().isoformat()
                        except Exception:
                            pass

                    # Odds: 1xbet uses "AE" list for odds
                    odds_1 = odds_x = odds_2 = None
                    markets = ev.get('AE', []) or ev.get('Markets', [])
                    for mkt in markets:
                        if mkt.get('T') in (1, 2):  # 1X2 market
                            for odd in mkt.get('E', []):
                                t = odd.get('T', 0)
                                v = odd.get('C') or odd.get('Cf')
                                if t == 1:
                                    odds_1 = float(v) if v else None
                                elif t == 2:
                                    odds_x = float(v) if v else None
                                elif t == 3:
                                    odds_2 = float(v) if v else None
                            break

                    status = default_status
                    minute = None
                    score = None
                    if default_status == 'live':
                        sc = ev.get('SC', {})
                        if sc:
                            score = {'home': str(sc.get('FS', {}).get('S1', 0)), 'away': str(sc.get('FS', {}).get('S2', 0))}
                        minute = ev.get('TM')

                    if match_date not in (today, tomorrow):
                        continue  # only today & tomorrow

                    results.append({
                        'id': eid,
                        'source': '1xbet',
                        'league': league_name,
                        'home': home,
                        'away': away,
                        'time': time_str,
                        'date': match_date,
                        'minute': minute,
                        'score': score,
                        'status': status,
                        'odds': {'1': odds_1, 'X': odds_x, '2': odds_2},
                        'url': f"https://1xbet.ci/fr/line/football/{eid}",
                    })
                except Exception:
                    continue
    except Exception:
        pass

    return results


# ─── Normalisation pour déduplication cross-sources ─────────────────────────
def norm_name(name):
    """Normalize team name for deduplication across sources"""
    n = name.lower()
    # strip common suffixes/prefixes
    for sub in ['fc', 'sc', 'ac', 'cf', 'rc', 'fk', 'sk', 'bk', 'as', 'ss', 'cd', 'sd', 'ud', 'rcd']:
        n = re.sub(r'\b' + sub + r'\b', '', n)
    # strip accents & special chars
    replacements = {'é':'e','è':'e','ê':'e','ë':'e','à':'a','â':'a','ô':'o','ù':'u','û':'u','ü':'u','î':'i','ï':'i','ç':'c'}
    for a, b in replacements.items():
        n = n.replace(a, b)
    n = re.sub(r'[^a-z0-9]', '', n)
    return n

def names_match(a, b):
    """True if two team names are the same (one may be a prefix/suffix of the other)"""
    na, nb = norm_name(a), norm_name(b)
    if na == nb:
        return True
    # one contains the other (e.g. "newcastle" ≈ "newcastleunited")
    if len(na) >= 4 and len(nb) >= 4:
        if na.startswith(nb) or nb.startswith(na):
            return True
    return False

def match_key(m):
    """Deduplication key: normalized home+away+date (use shorter form for fuzzy match)"""
    nh = norm_name(m['home'])
    na = norm_name(m['away'])
    # truncate to first 8 chars for fuzzy grouping
    return (nh[:8], na[:8], m['date'])


# ─── HTTP Handler ────────────────────────────────────────────────────────────
class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/api/matches' or self.path.startswith('/api/matches?'):
            self.serve_matches()
        else:
            super().do_GET()

    def serve_matches(self):
        try:
            today = datetime.date.today().isoformat()
            tomorrow = (datetime.date.today() + datetime.timedelta(days=1)).isoformat()

            # Run all sources in parallel
            with ThreadPoolExecutor(max_workers=4) as ex:
                f_betclic   = ex.submit(fetch_betclic)
                f_sofa_td   = ex.submit(fetch_sofascore, today)
                f_sofa_tm   = ex.submit(fetch_sofascore, tomorrow)
                f_1xbet     = ex.submit(fetch_1xbet)

                betclic_matches = f_betclic.result()
                sofa_today      = f_sofa_td.result()
                sofa_tomorrow   = f_sofa_tm.result()
                xbet_matches    = f_1xbet.result()

            sofascore_matches = sofa_today + sofa_tomorrow

            # Merge: betclic + 1xbet first (have odds), sofascore fills gaps
            seen_keys = {}  # key -> index in all_matches
            all_matches = []

            def add_matches(source_list):
                for m in source_list:
                    k = match_key(m)
                    if k in seen_keys:
                        # enrich existing match with source info
                        existing = all_matches[seen_keys[k]]
                        # if existing has no odds but new does, use new odds
                        if existing['odds']['1'] is None and m['odds']['1'] is not None:
                            existing['odds'] = m['odds']
                        # if new has score/minute and existing doesn't
                        if existing['score'] is None and m['score'] is not None:
                            existing['score'] = m['score']
                        if existing['minute'] is None and m['minute'] is not None:
                            existing['minute'] = m['minute']
                        # prefer live status
                        if m['status'] == 'live':
                            existing['status'] = 'live'
                        # accumulate sources
                        srcs = existing.get('sources', [existing['source']])
                        if m['source'] not in srcs:
                            srcs.append(m['source'])
                        existing['sources'] = srcs
                    else:
                        m['sources'] = [m['source']]
                        seen_keys[k] = len(all_matches)
                        all_matches.append(m)

            # Priority: betclic (odds) → 1xbet (odds) → sofascore (comprehensive fixture data)
            add_matches(betclic_matches)
            add_matches(xbet_matches)
            add_matches(sofascore_matches)

            # Filter: only today & tomorrow, live + upcoming only (no finished)
            all_matches = [m for m in all_matches
                           if m['date'] in (today, tomorrow)
                           and m['status'] in ('live', 'upcoming')]

            # Sort: live first, then by date, then by league
            all_matches.sort(key=lambda m: (
                0 if m['status'] == 'live' else 1,
                m['date'],
                m['league'],
                m['time'],
            ))

            body = json.dumps({
                'ok': True,
                'matches': all_matches,
                'count': len(all_matches),
                'sources': {
                    'betclic': len(betclic_matches),
                    'sofascore': len(sofascore_matches),
                    '1xbet': len(xbet_matches),
                },
            }, ensure_ascii=False).encode('utf-8')

        except Exception as e:
            import traceback
            body = json.dumps({'ok': False, 'error': str(e), 'trace': traceback.format_exc(), 'matches': []}).encode('utf-8')

        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    server = HTTPServer(('', PORT), Handler)
    print(f'Proxy running on http://localhost:{PORT}  [betclic + sofascore + 1xbet]', flush=True)
    server.serve_forever()
