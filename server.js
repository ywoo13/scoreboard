const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

// phase: 'idle'(시작 전 / 중단 후) | 'running'(경기 중) | 'paused'(일시정지)
// state 는 모든 클라이언트에게 공개되는 정보입니다. (시간은 포함하지 않음)
let state = { home: 0, away: 0, homeName: 'A팀', awayName: 'B팀', phase: 'idle' };

// 스톱워치는 서버 내부에만 보관하고, /status 로만 내려줍니다. (/events 에는 포함되지 않음)
let elapsedBase = 0;  // 지금까지 누적된 경기 시간(ms) - 일시정지 시점까지
let runStart = 0;     // 마지막으로 시계가 돌기 시작한 시각

function elapsedMs() {
  return elapsedBase + (state.phase === 'running' ? Date.now() - runStart : 0);
}
function fullState() {
  return Object.assign({}, state, { elapsedMs: elapsedMs() });
}

const clients = new Set();

function broadcast() {
  const msg = 'data: ' + JSON.stringify(state) + '\n\n';
  clients.forEach(function (res) { res.write(msg); });
}

// 클라이언트가 구독하는 스트림
app.get('/events', function (req, res) {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('data: ' + JSON.stringify(state) + '\n\n');   // 접속 즉시 현재 상태 전송
  clients.add(res);
  var ping = setInterval(function () { res.write(': ping\n\n'); }, 25000); // 연결 유지
  req.on('close', function () { clearInterval(ping); clients.delete(res); });
});

// 현재 상태 + 경기 시간 (관리자 화면용)
app.get('/status', function (req, res) {
  res.json(fullState());
});

// 점수 조정 (경기 시작 전에는 불가, 일시정지 중에는 심판 정정용으로 가능)
app.post('/score', function (req, res) {
  if (state.phase === 'idle') return res.status(409).json(fullState());
  var team = req.body.team, delta = Number(req.body.delta) || 0;
  if (team !== 'home' && team !== 'away') return res.status(400).end();
  state[team] = Math.max(0, state[team] + delta);
  broadcast();
  res.json(fullState());
});

// 경기 시작: 점수 0:0, 시간 0 부터 시작
app.post('/match/start', function (req, res) {
  if (state.phase !== 'idle') return res.status(409).json(fullState());
  state.home = 0; state.away = 0;
  elapsedBase = 0;
  runStart = Date.now();
  state.phase = 'running';
  broadcast();
  res.json(fullState());
});

// 일시정지: 점수와 시간은 유지, 로봇만 정지
app.post('/match/pause', function (req, res) {
  if (state.phase !== 'running') return res.status(409).json(fullState());
  elapsedBase += Date.now() - runStart;
  state.phase = 'paused';
  broadcast();
  res.json(fullState());
});

// 재개: 멈춘 시점부터 시계 이어서 진행
app.post('/match/resume', function (req, res) {
  if (state.phase !== 'paused') return res.status(409).json(fullState());
  runStart = Date.now();
  state.phase = 'running';
  broadcast();
  res.json(fullState());
});

// 경기 중단(종료): 로봇 정지 + 점수/시간 초기화
app.post('/match/stop', function (req, res) {
  state.home = 0; state.away = 0;
  elapsedBase = 0;
  runStart = 0;
  state.phase = 'idle';
  broadcast();
  res.json(fullState());
});

// 기본 주소(/) = 관리자 화면
app.get('/', function (req, res) {
  res.send(`<!doctype html><meta charset="utf-8"><meta name=viewport content="width=device-width,initial-scale=1">
<body style="font-family:sans-serif;text-align:center;background:#0f172a;color:#fff">
<h2>경기 관리</h2>
<div id=ph style="font-size:20px;margin-bottom:6px">연결 중...</div>
<div id=tm style="font-size:56px;font-weight:900;font-variant-numeric:tabular-nums;color:#fbbf24">00:00.0</div>
<h1 id=s>0 : 0</h1>

<div style="margin:10px 0">
<button id=bStart onclick="startM()" style="font-size:24px;padding:16px 22px;background:#16a34a;color:#fff;border:0;border-radius:10px">▶ 경기 시작</button>
<button id=bPause onclick="pauseM()" style="font-size:24px;padding:16px 22px;background:#f59e0b;color:#fff;border:0;border-radius:10px">⏸ 일시정지</button>
<button id=bStop onclick="stopM()" style="font-size:24px;padding:16px 22px;background:#dc2626;color:#fff;border:0;border-radius:10px">■ 경기 중단</button>
</div>

<div style="margin:18px 0">
<button id=bAp onclick="p('home',1)" style="font-size:28px;padding:20px">A팀 +1</button>
<button id=bBp onclick="p('away',1)" style="font-size:28px;padding:20px">B팀 +1</button><br><br>
<button id=bAm onclick="p('home',-1)">A팀 -1</button>
<button id=bBm onclick="p('away',-1)">B팀 -1</button>
</div>

<script>
var st = { home: 0, away: 0, phase: 'idle', elapsedMs: 0 };
var at = Date.now();   // st 를 받은 시각 (스톱워치를 부드럽게 돌리기 위함)

function handle(res) { return res.json().catch(function () { return null; }); }
function apply(d) {
  if (!d || d.phase === undefined) return;
  st = d; at = Date.now(); render();
}
function call(u, b) {
  return fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) })
    .then(handle).then(apply);
}
function refresh() {
  fetch('/status').then(handle).then(apply);
}

function pad(n) { return (n < 10 ? '0' : '') + n; }
function fmt(ms) {
  var t = Math.floor(ms / 100) / 10;           // 0.1초 단위
  var m = Math.floor(t / 60);
  var s = t - m * 60;
  return pad(m) + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
}

var PH = { idle: '⏹ 경기 대기 중 (로봇 정지)', running: '🟢 경기 진행 중', paused: '⏸ 일시정지 (로봇 정지)' };

function render() {
  document.getElementById('s').textContent = st.home + ' : ' + st.away;
  document.getElementById('ph').textContent = PH[st.phase] || '';
  var idle = st.phase === 'idle', paused = st.phase === 'paused';
  document.getElementById('bStart').disabled = !idle;
  var bp = document.getElementById('bPause');
  bp.disabled = idle;
  bp.textContent = paused ? '▶ 재개' : '⏸ 일시정지';
  document.getElementById('bStop').disabled = idle;
  ['bAp', 'bBp', 'bAm', 'bBm'].forEach(function (id) { document.getElementById(id).disabled = idle; });
}

function startM() { call('/match/start'); }
function pauseM() { call(st.phase === 'paused' ? '/match/resume' : '/match/pause'); }
function stopM() { if (confirm('경기를 중단할까요?\\n점수와 시간이 모두 초기화되고 로봇이 멈춥니다.')) call('/match/stop'); }
function p(t, d) { call('/score', { team: t, delta: d }); }

// 스톱워치 표시 (관리자 화면에서만 보임)
setInterval(function () {
  var e = st.elapsedMs + (st.phase === 'running' ? Date.now() - at : 0);
  document.getElementById('tm').textContent = fmt(e);
}, 100);

// 상태가 바뀔 때마다(다른 화면 포함) 서버 기준으로 다시 동기화
new EventSource('/events').onmessage = function () { refresh(); };
setInterval(refresh, 10000);
refresh();
</script>`);
});

app.listen(process.env.PORT || 3000);

