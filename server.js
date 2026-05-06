// PewPewPew – Serveur WebSocket multijoueur
// npm install ws  puis  node server.js
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

// Une seule room pour l'instant
const room = {
  clients : new Map(),   // ws → playerData
  hostWs  : null,
  nextId  : 1,
  free    : { blue: [0,1,2,3,4,5,6,7,8,9], red: [0,1,2,3,4,5,6,7,8,9] }
};

wss.on('connection', ws => {
  const pid = room.nextId++;
  room.clients.set(ws, { pid, team:null, slot:null, name:null, isHost:false });
  _send(ws, { type:'welcome', pid, count: room.clients.size });

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const pd = room.clients.get(ws);
    if (!pd) return;

    switch (msg.type) {

      case 'join': {
        const { team, name } = msg;
        if (!['blue','red'].includes(team)) return;
        const slots = room.free[team];
        if (!slots.length) { _send(ws,{type:'error',msg:'Équipe pleine'}); return; }
        pd.team  = team;
        pd.slot  = slots.shift();
        pd.name  = String(name||'JOUEUR').toUpperCase().slice(0,12);
        // Premier connecté → host
        if (!room.hostWs || room.hostWs.readyState !== 1) {
          room.hostWs = ws; pd.isHost = true;
        }
        // Liste des joueurs déjà présents pour le nouvel arrivant
        const players = [];
        for (const [,p] of room.clients)
          if (p.team) players.push({pid:p.pid,team:p.team,slot:p.slot,name:p.name,isHost:p.isHost});
        _send(ws, {type:'assigned',pid:pd.pid,team:pd.team,slot:pd.slot,name:pd.name,isHost:pd.isHost,players});
        // Notifier les autres
        _broadcast(ws, {type:'player_joined',pid:pd.pid,team:pd.team,slot:pd.slot,name:pd.name});
        console.log(`[+] ${pd.name} → ${pd.team}[${pd.slot}]${pd.isHost?' (host)':''}`);
        break;
      }

      case 'input':
        // Mémoriser le RTT du client pour choisir le meilleur host
        if (msg.rtt !== undefined) pd.rtt = msg.rtt;
        // DEBUG: log every 120th message to check x
        pd._dbgCount = (pd._dbgCount || 0) + 1;
        if (pd._dbgCount % 120 === 0) {
          console.log(`[INPUT] ${pd.name} slot=${pd.slot} x=${msg.x} hasX=${msg.x !== undefined} isHost=${ws === room.hostWs}`);
        }
        // Non-host → host : relayer l'input complet
        if (room.hostWs && room.hostWs !== ws && room.hostWs.readyState === 1) {
          const relayed = Object.assign({}, msg, {
            type:'input', pid:pd.pid, team:pd.team, slot:pd.slot
          });
          _send(room.hostWs, relayed);
        }
        break;

      case 'state':
      case 'event':
      case 'restart':
        // Host → tout le monde
        if (ws === room.hostWs) _broadcast(ws, msg);
        break;

      case 'resign_host': {
        // L'host cède volontairement son rôle (ex: onglet en arrière-plan)
        if (ws !== room.hostWs) break;
        console.log(`[H] ${pd.name} cède le rôle d'host`);
        pd.isHost = false;
        room.hostWs = null;
        // Promouvoir le client avec le meilleur RTT
        _promoteHost(ws);
        // Notifier l'ancien host qu'il est maintenant client
        _send(ws, { type: 'demoted_client' });
        break;
      }
    }
  });

  ws.on('close', () => {
    const pd = room.clients.get(ws);
    if (pd && pd.team) {
      room.free[pd.team].push(pd.slot);
      _broadcast(ws, {type:'player_left',pid:pd.pid,team:pd.team,slot:pd.slot});
      console.log(`[-] ${pd.name} déconnecté`);
      // Si le host part → promouvoir le client avec le meilleur RTT
      if (ws === room.hostWs) {
        room.hostWs = null;
        _promoteHost(ws);
      }
    }
    room.clients.delete(ws);
  });
});

// Promouvoir le client avec le meilleur RTT (hors ws exclu)
function _promoteHost(excludeWs) {
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
    console.log(`[H] Nouveau host : ${cp.name} (rtt=${bestRtt}ms)`);
  }
}

function _send(ws, obj)      { if (ws.readyState===1) ws.send(JSON.stringify(obj)); }
function _broadcast(exc,obj) {
  const s = JSON.stringify(obj);
  for (const [ws] of room.clients) if (ws!==exc && ws.readyState===1) ws.send(s);
}

// Keepalive : ping toutes les 30s pour éviter le timeout Railway
const PING_INTERVAL = 30_000;
setInterval(() => {
  for (const [ws] of room.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    } else {
      room.clients.delete(ws);
    }
  }
}, PING_INTERVAL);

console.log(`PewPewPew server → port ${PORT}`);
