// PewPewPew – Serveur WebSocket multijoueur
// npm install ws  puis  node server.js
const WebSocket = require('ws');
const PORT = process.env.PORT || 8080;
const wss  = new WebSocket.Server({ port: PORT });

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
        // Non-host → host : relayer l'input
        if (room.hostWs && room.hostWs !== ws && room.hostWs.readyState === 1)
          _send(room.hostWs, {type:'input',pid:pd.pid,team:pd.team,slot:pd.slot,keys:msg.keys});
        break;

      case 'state':
      case 'event':
        // Host → tout le monde
        if (ws === room.hostWs) _broadcast(ws, msg);
        break;
    }
  });

  ws.on('close', () => {
    const pd = room.clients.get(ws);
    if (pd && pd.team) {
      room.free[pd.team].push(pd.slot);
      _broadcast(ws, {type:'player_left',pid:pd.pid,team:pd.team,slot:pd.slot});
      console.log(`[-] ${pd.name} déconnecté`);
      // Si le host part → promouvoir un autre joueur
      if (ws === room.hostWs) {
        room.hostWs = null;
        for (const [cws,cp] of room.clients) {
          if (cws !== ws && cws.readyState === 1 && cp.team) {
            room.hostWs = cws; cp.isHost = true;
            _send(cws, {type:'promoted_host'});
            console.log(`[H] Nouveau host : ${cp.name}`);
            break;
          }
        }
      }
    }
    room.clients.delete(ws);
  });
});

function _send(ws, obj)      { if (ws.readyState===1) ws.send(JSON.stringify(obj)); }
function _broadcast(exc,obj) {
  const s = JSON.stringify(obj);
  for (const [ws] of room.clients) if (ws!==exc && ws.readyState===1) ws.send(s);
}

console.log(`PewPewPew server → port ${PORT}`);
