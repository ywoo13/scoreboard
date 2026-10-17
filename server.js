const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1); // Render 프록시 뒤에서 실제 IP / HTTPS 인식

/* ---------- 관리자 암호 / 세션 ---------- */
// Render > Environment 에 ADMIN_PASSWORD (12자 이상 권장), SESSION_SECRET (긴 랜덤 문자열) 설정
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.ADMIN_KEY || '';
if (!ADMIN_PASSWORD) {
  ADMIN_PASSWORD = crypto.randomBytes(9).toString('base64url');
  console.log('[보안] ADMIN_PASSWORD 환경변수가 없어 임시 암호를 만들었습니다:', ADMIN_PASSWORD);
}
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_MS = 8 * 60 * 60 * 1000;

function sha(v) { return crypto.createHash('sha256').update(String(v)).digest(); }
function safeEq(a, b) { return crypto.timingSafeEqual(sha(a), sha(b)); }
function sign(v) { return crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex'); }

function readSession(req) {
  var c = (req.headers.cookie || '').split(';').map(function (s) { return s.trim(); })
    .find(function (s) { return s.indexOf('adm=') === 0; });
  if (!c) return false;
  var val = c.slice(4), i = val.indexOf('.');
  if (i < 0) return false;
  var exp = val.slice(0, i), sig = val.slice(i + 1);
  return safeEq(sig, sign(exp)) && Number(exp) > Date.now();
}

function sameOrigin(req) {
  var o = req.get('origin');
  return !o || o === req.protocol + '://' + req.get('host');
}

function auth(req, res, next) {
  if (!readSession(req)) return res.status(401).json({ error: 'unauthorized' });
  if (req.method !== 'GET' && !sameOrigin(req)) return res.status(403).json({ error: 'forbidden' });
  next();
}

/* ---------- 공통 보안 설정 ---------- */
app.use(function (req, res, next) {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  next();
});
app.use(express.json({ limit: '2kb' }));

// 간단한 횟수 제한 (메모리)
const buckets = new Map(); // key -> { n, reset }
function limited(key, max, ms) {
  var now = Date.now(), b = buckets.get(key);
  if (!b || now > b.reset) { b = { n: 0, reset: now + ms }; buckets.set(key, b); }
  b.n++;
  return b.n > max;
}

// 로그인 실패 잠금: 5회 이후 30초부터 2배씩(최대 15분)
const fails = new Map(); // ip -> { n, until }
function lockedOut(ip) { var f = fails.get(ip); return !!f && Date.now() < f.until; }
function addFail(ip) {
  var f = fails.get(ip) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) f.until = Date.now() + Math.min(15 * 60 * 1000, 30000 * Math.pow(2, f.n - 5));
  fails.set(ip, f);
}

/* ---------- 경기 상태 ---------- */
// phase: 'idle'(대기) | 'running'(경기 중) | 'paused'(일시정지) | 'finished'(종료, 결과 표시 중)
let state = { home: 0, away: 0, homeName: 'A팀', awayName: 'B팀', phase: 'idle', result: null };
let elapsedBase = 0;  // 일시정지/종료 시점까지 누적된 경기 시간(ms)
let runStart = 0;     // 마지막으로 시계가 돌기 시작한 시각

function elapsedMs() {
  return elapsedBase + (state.phase === 'running' ? Date.now() - runStart : 0);
}

/* ---------- 플레이어(클라이언트) 번호 / 팀 ---------- */
// team: 'A' | 'B' | null(미배정) — 관리자가 직접 배정
const players = new Map(); // token -> { token, id, team, conns, lastSeen }
let nextId = 1;
const MAX_PLAYERS = 500;
const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

function sortedPlayers() {
  return Array.from(players.values()).sort(function (a, b) { return a.id - b.id; });
}

// 서버가 발급한 토큰만 인정 (모르는 토큰이면 새로 발급)
function joinPlayer(token) {
  var p = (typeof token === 'string' && TOKEN_RE.test(token)) ? players.get(token) : null;
  if (!p) {
    if (players.size >= MAX_PLAYERS) {            // 가득 차면 오래된 미배정 오프라인 번호부터 정리
      var victim = sortedPlayers().find(function (x) { return x.conns === 0 && !x.team; });
      if (!victim) return null;
      players.delete(victim.token);
    }
    p = { token: crypto.randomUUID(), id: nextId++, team: null, conns: 0, lastSeen: Date.now() };
    players.set(p.token, p);
  }
  p.lastSeen = Date.now();
  return p;
}

function outcomeFor(p) {
  if (state.phase !== 'finished' || !state.result || !p.team) return null;
  if (state.result.winner === 'draw') return 'draw';
  return state.result.winner === p.team ? 'win' : 'lose';
}
function playerView(p) { return { id: p.id, team: p.team, outcome: outcomeFor(p) }; }
function playerList() {
  return sortedPlayers().map(function (p) { return { id: p.id, team: p.team, online: p.conns > 0 }; });
}
function fullState() {
  return Object.assign({}, state, { elapsedMs: elapsedMs(), players: playerList() });
}

/* ---------- SSE (플레이어/관전자용, 공개) ---------- */
const clients = new Map(); // res -> token | null (null = 관전자/관리자)
const ipConns = new Map();
const MAX_SSE = 400, MAX_SSE_PER_IP = 100;

function payloadFor(token) {
  var s = Object.assign({}, state);
  var p = token ? players.get(token) : null;
  if (p) s.you = playerView(p);           // 플레이어에게만 내 번호/팀/승패를 함께 보냄
  return 'data: ' + JSON.stringify(s) + '\n\n';
}
function broadcast() {
  clients.forEach(function (token, res) {
    try { res.write(payloadFor(token)); } catch (e) { clients.delete(res); }
  });
}

app.get('/events', cors(), function (req, res) {
  var ip = req.ip;
  if (clients.size >= MAX_SSE || (ipConns.get(ip) || 0) >= MAX_SSE_PER_IP) return res.status(503).end();
  ipConns.set(ip, (ipConns.get(ip) || 0) + 1);

  var token = typeof req.query.token === 'string' ? req.query.token : '';
  var p = TOKEN_RE.test(token) ? players.get(token) : null;

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders();
  res.write(payloadFor(p ? p.token : null));
  clients.set(res, p ? p.token : null);
  if (p) { p.conns++; p.lastSeen = Date.now(); broadcast(); }

  var ping = setInterval(function () { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);

  req.on('close', function () {
    clearInterval(ping);
    clients.delete(res);
    var c = (ipConns.get(ip) || 1) - 1;
    if (c <= 0) ipConns.delete(ip); else ipConns.set(ip, c);
    if (p) { p.conns = Math.max(0, p.conns - 1); p.lastSeen = Date.now(); broadcast(); }
  });
});

// 플레이어 가입: 번호만 배정 (팀은 관리자가 지정). 같은 토큰으로 다시 오면 같은 번호 유지
app.options('/join', cors());
app.post('/join', cors(), function (req, res) {
  if (limited('join:' + req.ip, 120, 60 * 1000)) return res.status(429).json({ error: 'too many' });
  var p = joinPlayer(req.body && req.body.token);
  if (!p) return res.status(503).json({ error: 'full' });
  broadcast();
  res.json({ token: p.token, you: playerView(p) });
});

/* ---------- 관리자 로그인 ---------- */
app.post('/login', function (req, res) {
  if (!sameOrigin(req)) return res.status(403).json({ error: 'forbidden' });
  var ip = req.ip;
  if (lockedOut(ip)) return res.status(429).json({ error: 'locked' });
  var pw = req.body && typeof req.body.password === 'string' ? req.body.password : '';
  if (safeEq(pw, ADMIN_PASSWORD)) {
    fails.delete(ip);
    var exp = String(Date.now() + SESSION_MS);
    res.cookie('adm', exp + '.' + sign(exp), { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: SESSION_MS, path: '/' });
    return res.json({ ok: true });
  }
  addFail(ip);
  res.status(401).json({ error: 'wrong' });
});

app.post('/logout', function (req, res) {
  if (!sameOrigin(req)) return res.status(403).json({ error: 'forbidden' });
  res.clearCookie('adm', { path: '/' });
  res.json({ ok: true });
});

/* ---------- 관리자 API (로그인 필요) ---------- */
app.get('/status', auth, function (req, res) {
  res.set('Cache-Control', 'no-store');
  res.json(fullState());
});

// 팀 배정: team = 'A' | 'B' | '' (미배정으로 되돌리기). 종료 후에는 변경 불가
app.post('/player/team', auth, function (req, res) {
  if (state.phase === 'finished') return res.status(409).json(fullState());
  var id = Number(req.body.id), team = req.body.team;
  if (team === '' || team === null) team = null;
  else if (team !== 'A' && team !== 'B') return res.status(400).end();
  var found = sortedPlayers().find(function (p) { return p.id === id; });
  if (!found) return res.status(404).json(fullState());
  found.team = team;
  broadcast();
  res.json(fullState());
});

// 홀짝 자동 배정 (번호 순서대로 A, B, A, B ...) — 대기 상태에서만
app.post('/players/auto', auth, function (req, res) {
  if (state.phase !== 'idle') return res.status(409).json(fullState());
  sortedPlayers().forEach(function (p, i) { p.team = i % 2 === 0 ? 'A' : 'B'; });
  broadcast();
  res.json(fullState());
});

// 전체 미배정으로 — 대기 상태에서만
app.post('/players/clear', auth, function (req, res) {
  if (state.phase !== 'idle') return res.status(409).json(fullState());
  players.forEach(function (p) { p.team = null; });
  broadcast();
  res.json(fullState());
});

// 점수 조정 (경기 중/일시정지 중에만 가능)
app.post('/score', auth, function (req, res) {
  if (state.phase !== 'running' && state.phase !== 'paused') return res.status(409).json(fullState());
  var team = req.body.team, delta = Math.trunc(Number(req.body.delta)) || 0;
  if (team !== 'home' && team !== 'away') return res.status(400).end();
  state[team] = Math.max(0, state[team] + delta);
  broadcast();
  res.json(fullState());
});

app.post('/match/start', auth, function (req, res) {
  if (state.phase !== 'idle') return res.status(409).json(fullState());
  state.home = 0; state.away = 0; state.result = null;
  elapsedBase = 0;
  runStart = Date.now();
  state.phase = 'running';
  broadcast();
  res.json(fullState());
});

app.post('/match/pause', auth, function (req, res) {
  if (state.phase !== 'running') return res.status(409).json(fullState());
  elapsedBase += Date.now() - runStart;
  state.phase = 'paused';
  broadcast();
  res.json(fullState());
});

app.post('/match/resume', auth, function (req, res) {
  if (state.phase !== 'paused') return res.status(409).json(fullState());
  runStart = Date.now();
  state.phase = 'running';
  broadcast();
  res.json(fullState());
});

// 경기 종료: 로봇 정지 + 승패 확정 → 배정된 플레이어에게 승리/패배/무승부 전송
app.post('/match/end', auth, function (req, res) {
  if (state.phase !== 'running' && state.phase !== 'paused') return res.status(409).json(fullState());
  if (state.phase === 'running') elapsedBase += Date.now() - runStart;
  runStart = 0;
  state.phase = 'finished';
  state.result = { winner: state.home > state.away ? 'A' : state.home < state.away ? 'B' : 'draw' };
  broadcast();
  res.json(fullState());
});

// 초기화: 점수/시간/결과를 지우고 대기 상태로 (팀 배정은 유지)
app.post('/match/reset', auth, function (req, res) {
  state.home = 0; state.away = 0; state.result = null;
  elapsedBase = 0;
  runStart = 0;
  state.phase = 'idle';
  broadcast();
  res.json(fullState());
});

// 정리: 30분 넘게 접속 없는 플레이어, 만료된 제한/잠금 기록
setInterval(function () {
  var now = Date.now();
  players.forEach(function (p, token) {
    if (p.conns === 0 && now - p.lastSeen > 30 * 60 * 1000) players.delete(token);
  });
  buckets.forEach(function (b, k) { if (now > b.reset) buckets.delete(k); });
  fails.forEach(function (f, k) { if (now > f.until + 30 * 60 * 1000) fails.delete(k); });
}, 5 * 60 * 1000);

/* ---------- 화면 (같은 주소 '/': 로그인 전 = 로그인 폼, 후 = 관리자 화면) ---------- */
function loginPage(nonce) {
  return `<!doctype html><meta charset="utf-8"><meta name=viewport content="width=device-width,initial-scale=1">
<title>경기 관리 로그인</title>
<body style="font-family:sans-serif;text-align:center;background:#0f172a;color:#fff;padding-top:12vh">
<h2>경기 관리</h2>
<form id=f style="margin:20px 0">
<input id=pw type=password autocomplete=current-password placeholder="관리자 암호" autofocus style="font-size:20px;padding:12px;border-radius:10px;border:1px solid #334155;background:#1e293b;color:#fff">
<button style="font-size:20px;padding:12px 18px;border:0;border-radius:10px;background:#16a34a;color:#fff">로그인</button>
</form>
<div id=msg style="color:#f87171;min-height:24px"></div>
<script nonce="${nonce}">
document.getElementById('f').addEventListener('submit', function (e) {
  e.preventDefault();
  fetch('/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: document.getElementById('pw').value }) })
    .then(function (r) {
      if (r.ok) { location.reload(); return; }
      document.getElementById('msg').textContent = r.status === 429 ? '시도가 너무 많습니다. 잠시 후 다시 시도하세요.' : '암호가 올바르지 않습니다.';
      document.getElementById('pw').select();
    });
});
</script>`;
}

function adminPage(nonce) {
  return `<!doctype html><meta charset="utf-8"><meta name=viewport content="width=device-width,initial-scale=1">
<title>경기 관리</title>
<body style="font-family:sans-serif;text-align:center;background:#0f172a;color:#fff">
<div style="text-align:right;padding:8px"><button data-act="logout">로그아웃</button></div>
<h2>경기 관리</h2>
<div id=ph style="font-size:20px;margin-bottom:6px">연결 중...</div>
<div id=tm style="font-size:56px;font-weight:900;font-variant-numeric:tabular-nums;color:#fbbf24">00:00.0</div>
<h1 id=s>0 : 0</h1>

<div style="margin:10px 0">
<button id=bStart data-act="start" style="font-size:22px;padding:14px 18px;background:#16a34a;color:#fff;border:0;border-radius:10px">▶ 경기 시작</button>
<button id=bPause data-act="pause" style="font-size:22px;padding:14px 18px;background:#f59e0b;color:#fff;border:0;border-radius:10px">⏸ 일시정지</button>
<button id=bEnd data-act="end" style="font-size:22px;padding:14px 18px;background:#dc2626;color:#fff;border:0;border-radius:10px">🏁 경기 종료</button>
<button id=bReset data-act="reset" style="font-size:22px;padding:14px 18px;background:#475569;color:#fff;border:0;border-radius:10px">↺ 초기화</button>
</div>

<div style="margin:18px 0">
<button id=bAp data-act="score" data-team="home" data-d="1" style="font-size:28px;padding:20px">A팀 +1</button>
<button id=bBp data-act="score" data-team="away" data-d="1" style="font-size:28px;padding:20px">B팀 +1</button><br><br>
<button id=bAm data-act="score" data-team="home" data-d="-1">A팀 -1</button>
<button id=bBm data-act="score" data-team="away" data-d="-1">B팀 -1</button>
</div>

<h3>팀 배정 <span id=pc style="font-size:14px;color:#94a3b8"></span></h3>
<div style="margin-bottom:10px">
<button id=bAuto data-act="auto" style="font-size:16px;padding:10px 14px">🔀 홀짝 자동 배정</button>
<button id=bClear data-act="clear" style="font-size:16px;padding:10px 14px">⬜ 전체 해제</button>
</div>
<div id=pl style="display:flex;justify-content:center;gap:12px;flex-wrap:wrap"></div>

<script nonce="${nonce}">
var st = { home: 0, away: 0, phase: 'idle', elapsedMs: 0, players: [] };
var at = Date.now();

function handle(res) { return res.json().catch(function () { return null; }); }
function apply(d) {
  if (!d || d.phase === undefined) return;
  st = d; at = Date.now(); render();
}
function call(u, b) {
  return fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) })
    .then(function (res) {
      if (res.status === 401 || u === '/logout') { location.reload(); return null; }
      return handle(res);
    })
    .then(apply);
}
function refresh() {
  fetch('/status').then(function (res) {
    if (res.status === 401) { location.reload(); return null; }
    return handle(res);
  }).then(apply);
}

function pad(n) { return (n < 10 ? '0' : '') + n; }
function fmt(ms) {
  var t = Math.floor(ms / 100) / 10;
  var m = Math.floor(t / 60);
  var s = t - m * 60;
  return pad(m) + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
}

var PH = {
  idle: '⏹ 경기 대기 중 (로봇 정지)',
  running: '🟢 경기 진행 중',
  paused: '⏸ 일시정지 (로봇 정지)',
  finished: '🏁 경기 종료'
};
var COLS = [
  { k: '',  title: '미배정', color: '#94a3b8' },
  { k: 'A', title: 'A팀',    color: '#38bdf8' },
  { k: 'B', title: 'B팀',    color: '#f87171' }
];

function render() {
  document.getElementById('s').textContent = st.home + ' : ' + st.away;

  var msg = PH[st.phase] || '';
  if (st.phase === 'finished' && st.result) {
    msg += st.result.winner === 'draw' ? ' — 무승부' : ' — ' + st.result.winner + '팀 승리!';
  }
  document.getElementById('ph').textContent = msg;

  var idle = st.phase === 'idle', paused = st.phase === 'paused', finished = st.phase === 'finished';
  var playing = st.phase === 'running' || paused;
  document.getElementById('bStart').disabled = !idle;
  var bp = document.getElementById('bPause');
  bp.disabled = !playing;
  bp.textContent = paused ? '▶ 재개' : '⏸ 일시정지';
  document.getElementById('bEnd').disabled = !playing;
  document.getElementById('bReset').disabled = idle;
  ['bAp', 'bBp', 'bAm', 'bBm'].forEach(function (id) { document.getElementById(id).disabled = !playing; });
  document.getElementById('bAuto').disabled = !idle;
  document.getElementById('bClear').disabled = !idle;

  var players = st.players || [];
  var online = { '': 0, A: 0, B: 0 };
  var html = '';
  COLS.forEach(function (col) {
    var list = players.filter(function (p) { return (p.team || '') === col.k; });
    list.forEach(function (p) { if (p.online) online[col.k]++; });
    html += '<div style="min-width:200px;padding:10px;border-radius:12px;background:#111c33;border:2px solid ' + col.color + '">' +
      '<div style="font-weight:900;color:' + col.color + ';margin-bottom:8px">' + col.title + ' (' + list.length + ')</div>';
    list.forEach(function (p) {
      html += '<div style="margin:6px 0;padding:6px 8px;border-radius:8px;background:#1e293b;opacity:' + (p.online ? 1 : 0.4) + '">' +
        '#' + Number(p.id) + ' ' + (p.online ? '🟢' : '⚪') + ' ';
      COLS.forEach(function (to) {
        if (to.k === col.k) return;
        html += '<button data-id="' + Number(p.id) + '" data-team="' + to.k + '"' + (finished ? ' disabled' : '') + '>' +
          (to.k === '' ? '해제' : to.k) + '</button> ';
      });
      html += '</div>';
    });
    if (!list.length) html += '<div style="color:#64748b;font-size:14px">비어 있음</div>';
    html += '</div>';
  });
  document.getElementById('pl').innerHTML = html;
  document.getElementById('pc').textContent = '(접속 중 A ' + online.A + '명 / B ' + online.B + '명 / 미배정 ' + online[''] + '명)';
}

function startM() {
  var un = (st.players || []).filter(function (p) { return p.online && !p.team; }).length;
  if (un && !confirm('미배정 접속자가 ' + un + '명 있습니다. 이 사람들은 로봇을 조종할 수 없습니다.\\n그대로 시작할까요?')) return;
  call('/match/start');
}
function pauseM() { call(st.phase === 'paused' ? '/match/resume' : '/match/pause'); }
function endM() { if (confirm('경기를 종료할까요?\\n점수가 확정되고 각 팀 플레이어에게 승패가 표시됩니다.')) call('/match/end'); }
function resetM() { if (confirm('초기화할까요?\\n점수와 시간이 0으로 돌아가고 대기 상태가 됩니다. (팀 배정은 유지)')) call('/match/reset'); }
function clearT() { if (confirm('모든 번호를 미배정으로 되돌릴까요?')) call('/players/clear'); }

document.addEventListener('click', function (e) {
  var t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.id) { call('/player/team', { id: Number(t.dataset.id), team: t.dataset.team }); return; }
  var a = t.dataset.act;
  if (a === 'start') startM();
  else if (a === 'pause') pauseM();
  else if (a === 'end') endM();
  else if (a === 'reset') resetM();
  else if (a === 'auto') call('/players/auto');
  else if (a === 'clear') clearT();
  else if (a === 'score') call('/score', { team: t.dataset.team, delta: Number(t.dataset.d) });
  else if (a === 'logout') call('/logout');
});

setInterval(function () {
  var e = st.elapsedMs + (st.phase === 'running' ? Date.now() - at : 0);
  document.getElementById('tm').textContent = fmt(e);
}, 100);

new EventSource('/events').onmessage = function () { refresh(); };
setInterval(refresh, 10000);
refresh();
</script>`;
}

app.get('/', function (req, res) {
  var nonce = crypto.randomBytes(16).toString('base64');
  res.set({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'unsafe-inline'; " +
      "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
  });
  res.send(readSession(req) ? adminPage(nonce) : loginPage(nonce));
});

// 잘못된 요청(JSON 오류 등)은 스택 없이 일반 오류로
app.use(function (err, req, res, next) {
  res.status(400).json({ error: 'bad request' });
});

app.listen(process.env.PORT || 3000);

