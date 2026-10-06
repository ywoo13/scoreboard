const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

const ADMIN_KEY = process.env.ADMIN_KEY;
let state = { home: 0, away: 0, homeName: 'A팀', awayName: 'B팀' };
const clients = new Set();

function broadcast() {
  const msg = 'data: ' + JSON.stringify(state) + '\n\n';
  clients.forEach(function (res) { res.write(msg); });
}

// 클라이언트가 구독하는 스트림
app.get('/events', function (req, res) {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('data: ' + JSON.stringify(state) + '\n\n');   // 접속 즉시 현재 점수 전송
  clients.add(res);
  var ping = setInterval(function () { res.write(': ping\n\n'); }, 25000); // 연결 유지
  req.on('close', function () { clearInterval(ping); clients.delete(res); });
});

function auth(req, res, next) {
  if (!ADMIN_KEY || req.get('x-admin-key') !== ADMIN_KEY) return res.status(401).end();
  next();
}

app.post('/score', auth, function (req, res) {
  var team = req.body.team, delta = Number(req.body.delta) || 0;
  if (team !== 'home' && team !== 'away') return res.status(400).end();
  state[team] = Math.max(0, state[team] + delta);
  broadcast();
  res.json(state);
});

app.post('/reset', auth, function (req, res) {
  state.home = 0; state.away = 0;
  broadcast();
  res.json(state);
});

// 관리자 페이지
app.get('/admin', function (req, res) {
  res.send(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<body style="font-family:sans-serif;text-align:center;background:#0f172a;color:#fff">
<h2>점수 관리</h2><h1 id=s>0 : 0</h1>
<button onclick="p('home',1)" style="font-size:28px;padding:20px">A팀 +1</button>
<button onclick="p('away',1)" style="font-size:28px;padding:20px">B팀 +1</button><br><br>
<button onclick="p('home',-1)">A팀 -1</button>
<button onclick="p('away',-1)">B팀 -1</button>
<button onclick="r()">초기화</button>
<script>
var key = sessionStorage.k || (sessionStorage.k = prompt('관리자 키'));
function call(u, b){ return fetch(u,{method:'POST',headers:{'Content-Type':'application/json','x-admin-key':key},body:JSON.stringify(b||{})}); }
function p(t,d){ call('/score',{team:t,delta:d}); }
function r(){ if(confirm('초기화할까요?')) call('/reset'); }
new EventSource('/events').onmessage=function(e){var d=JSON.parse(e.data);document.getElementById('s').textContent=d.home+' : '+d.away;};
</script>`);
});

app.listen(process.env.PORT || 3000);