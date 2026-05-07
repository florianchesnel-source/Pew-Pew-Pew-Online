// PewPewPew – Serveur WebSocket multijoueur (rooms pc / mobile / mixed)
const WebSocket = require('ws');
const http = require('http');
const PORT = process.env.PORT || 8080;

// Serveur HTTP pour le health check Railway + upgrade WebSocket
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('PewPewPew OK');
});
const wss = new WebSocket.Server({ server });
server.listen(PORT);

// ── Rooms ─────────────────────────────────────────────────────────────────
function makeRoom(name) {
  return {
    name,
    clients : new Map(),   // ws → playerData
    hostWs  : null,
    nextId  : 1,
    free    : { blue: [0,1,2,3,4,5,6,7,8,9], red: [0,1,2,3,4,5,6,7,8,9] }
  };
}

const rooms = {
  pc    : makeRoom('pc'),
  mobile: makeRoom('mobile'),
  mixed : makeRoom('mixed'),
};

// Map globale ws → playerData (contient aussi la room d'appartenance)
const wsData = new Map();
let _nextPid = 1;

// ── Connexion ─────────────────────────────────────────────────────────────
wss.on('connection', ws => {
  const pid = _nextPid++;
  wsData.set(ws, { pid, room: null, team: null, slot: null, name: null, isHost: false, rtt: undefined });
  _send(ws, { type: 'welcome', pid });

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const pd = wsData.get(ws);
    if (!pd) return;

    switch (msg.type) {

      case 'join': {
        if (pd.room) return; // déjà dans une room
        const { team, name } = msg;
        if (!['blue','red'].includes(team)) return;

        // Choisir la room selon la plateforme envoyée par le client
        const platform = msg.platform === 'mobile' ? 'mobile'
                       : msg.platform === 'mixed'  ? 'mixed'
                       : 'pc';
        const room = rooms[platform];

        const slots = room.free[team];
        if (!slots.length) { _send(ws, { type: 'error', msg: 'Équipe pleine' }); return; }

        pd.room   = room;
        pd.team   = team;
        pd.slot   = slots.shift();
        pd.name   = String(name || 'JOUEUR').toUpperCase().slice(0, 12);
        room.clients.set(ws, pd);

        // Premier connecté → host
        if (!room.hostWs || room.hostWs.readyState !== 1) {
          room.hostWs = ws; pd.isHost = true;
        }

        // Liste des joueurs déjà présents pour le nouvel arrivant
        const players = [];
        for (const [, p] of room.clients)
          if (p.team) players.push({ pid: p.pid, team: p.team, slot: p.slot, name: p.name, isHost: p.isHost });
        _send(ws, { type: 'assigned', pid: pd.pid, team: pd.team, slot: pd.slot, name: pd.name, isHost: pd.isHost, players });

        // Notifier les autres joueurs de la même room
        _broadcast(room, ws, { type: 'player_joined', pid: pd.pid, team: pd.team, slot: pd.slot, name: pd.name });
        console.log(`[+][${room.name}] ${pd.name} → ${pd.team}[${pd.slot}]${pd.isHost ? ' (host)' : ''}`);
        break;
      }

      case 'input': {
        const room = pd.room;
        if (!room) return;
        if (msg.rtt !== undefined) pd.rtt = msg.rtt;
        // Non-host → host : relayer l'input complet
        if (room.hostWs && room.hostWs !== ws && room.hostWs.readyState === 1) {
          _send(room.hostWs, Object.assign({}, msg, { type: 'input', pid: pd.pid, team: pd.team, slot: pd.slot }));
        }
        break;
      }

      case 'state':
      case 'event':
      case 'restart': {
        const room = pd.room;
        if (!room) return;
        if (ws === room.hostWs) _broadcast(room, ws, msg);
        break;
      }

      case 'resign_host': {
        const room = pd.room;
        if (!room || ws !== room.hostWs) break;
        console.log(`[H][${room.name}] ${pd.name} cède le rôle d'host`);
        pd.isHost = false;
        room.hostWs = null;
        _promoteHost(room, ws);
        _send(ws, { type: 'demoted_client' });
        break;
      }
    }
  });

  ws.on('close', () => {
    const pd = wsData.get(ws);
    if (pd) {
      const room = pd.room;
      if (room && pd.team) {
        room.free[pd.team].push(pd.slot);
        _broadcast(room, ws, { type: 'player_left', pid: pd.pid, team: pd.team, slot: pd.slot });
        console.log(`[-][${room.name}] ${pd.name} déconnecté`);
        if (ws === room.hostWs) {
          room.hostWs = null;
          _promoteHost(room, ws);
        }
        room.clients.delete(ws);
      }
    }
    wsData.delete(ws);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────
function _promoteHost(room, excludeWs) {
  let bestWs = null, bestRtt = Infinity;
  for (const [cws, cp] of room.clients) {
    if (cws === excludeWs || cws.readyState !== 1 || !cp.team) continue;
    const rtt = cp.rtt !== undefined ? cp.rtt : 9999;
    if (rtt < bestRtt) { bestRtt = rtt; bestWs = cws; }
  }
  if (bestWs) {
    const cp = room.clients.get(bestWs);
    room.hostWs = bestWs; cp.isHost = true;
    _send(bestWs, { type: 'promoted_host' });
    console.log(`[H][${room.name}] Nouveau host : ${cp.name} (rtt=${bestRtt}ms)`);
  }
}

function _send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function _broadcast(room, exc, obj) {
  const s = JSON.stringify(obj);
  for (const [ws] of room.clients) if (ws !== exc && ws.readyState === 1) ws.send(s);
}

// ── Keepalive ping toutes les 30s ─────────────────────────────────────────
setInterval(() => {
  for (const [ws] of wsData) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    } else {
      wsData.delete(ws);
    }
  }
}, 30_000);

console.log(`PewPewPew server → port ${PORT} (rooms: pc / mobile / mixed)`);
