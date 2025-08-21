// WebSocket signaling server (Phase 1)
// - In-memory rooms with simple join/leave
// - Forward SDP offers/answers and ICE candidates between peers
// - Stateless across restarts

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

// Provide a basic HTTP health endpoint for easy checks
const server = http.createServer((req, res) => {
	res.writeHead(200, { 'Content-Type': 'text/plain' });
	res.end('ok');
});
const wss = new WebSocket.Server({ server });

// roomId -> Map<peerId, ws>
const rooms = new Map();

// Utility to send JSON messages to a client
function sendJson(targetWs, message) {
	try {
		targetWs.send(JSON.stringify(message));
	} catch (err) {
		console.error('[signaling] send error', err);
	}
}

// Broadcast to all peers in the room except optionally one
function broadcast(roomId, message, exceptPeerId = null) {
	const room = rooms.get(roomId);
	if (!room) return;
	for (const [peerId, peerWs] of room.entries()) {
		if (exceptPeerId && peerId === exceptPeerId) continue;
		sendJson(peerWs, message);
	}
}

// Cleanly remove a peer from its room (if any) and notify others
function removePeerFromRoom(ws) {
	const { roomId, peerId } = ws;
	if (!roomId || !peerId) return;
	const room = rooms.get(roomId);
	if (!room) return;
	if (room.has(peerId)) {
		room.delete(peerId);
		broadcast(roomId, { type: 'peer-left', peerId }, null);
	}
	if (room.size === 0) {
		rooms.delete(roomId);
	}
	ws.roomId = undefined;
	ws.peerId = undefined;
}

// Handle new connections
wss.on('connection', (ws) => {
	console.log('[signaling] client connected');
	// Track liveness for cleanup (optional heartbeat)
	ws.isAlive = true;
	ws.on('pong', () => { ws.isAlive = true; });

	ws.on('message', (raw) => {
		let msg;
		try {
			msg = JSON.parse(raw);
		} catch (e) {
			return sendJson(ws, { type: 'error', error: 'invalid-json' });
		}

		const { type } = msg || {};
		console.log('[signaling] recv', type);
		switch (type) {
			case 'join': {
				// { type: 'join', roomId: string, peerId: string }
				const { roomId, peerId } = msg;
				if (!roomId || !peerId) return sendJson(ws, { type: 'error', error: 'missing-room-or-peer' });

				let room = rooms.get(roomId);
				if (!room) {
					room = new Map();
					rooms.set(roomId, room);
				}
				if (room.has(peerId)) {
					return sendJson(ws, { type: 'error', error: 'peer-id-taken' });
				}

				ws.roomId = roomId;
				ws.peerId = peerId;
				room.set(peerId, ws);

				// Inform the joiner of current peers
				const existingPeers = Array.from(room.keys()).filter((p) => p !== peerId);
				sendJson(ws, { type: 'joined', roomId, peerId, peers: existingPeers });

				// Notify others about the new peer
				broadcast(roomId, { type: 'peer-joined', peerId }, peerId);
				break;
			}

			case 'leave': {
				removePeerFromRoom(ws);
				sendJson(ws, { type: 'left' });
				break;
			}

			case 'offer':
			case 'answer':
			case 'candidate': {
				// Forward to a specific peer in the same room
				// offer: { type:'offer', targetPeerId, sdp }
				// answer: { type:'answer', targetPeerId, sdp }
				// candidate: { type:'candidate', targetPeerId, candidate }
				const { targetPeerId } = msg;
				const { roomId, peerId } = ws;
				if (!roomId || !peerId) return sendJson(ws, { type: 'error', error: 'not-in-room' });
				const room = rooms.get(roomId);
				if (!room) return sendJson(ws, { type: 'error', error: 'room-not-found' });
				const target = room.get(targetPeerId);
				if (!target) return sendJson(ws, { type: 'error', error: 'target-not-found' });

				const payload = { ...msg, fromPeerId: peerId };
				delete payload.targetPeerId; // not needed by receiver when 'fromPeerId' is present
				sendJson(target, payload);
				break;
			}

			case 'list-peers': {
				const { roomId } = ws;
				if (!roomId) return sendJson(ws, { type: 'peers', peers: [] });
				const room = rooms.get(roomId);
				const peers = room ? Array.from(room.keys()) : [];
				sendJson(ws, { type: 'peers', peers });
				break;
			}

			case 'ping': {
				sendJson(ws, { type: 'pong' });
				break;
			}

			default:
				sendJson(ws, { type: 'error', error: 'unknown-type' });
		}
	});

	ws.on('close', () => {
		removePeerFromRoom(ws);
	});

	ws.on('error', (err) => {
		console.error('[signaling] ws error', err);
	});
});

// Optional heartbeat to detect dead connections
const heartbeatInterval = setInterval(() => {
	for (const ws of wss.clients) {
		if (ws.isAlive === false) {
			try { ws.terminate(); } catch (_) {}
			continue;
		}
		ws.isAlive = false;
		try { ws.ping(); } catch (_) {}
	}
}, 30000);

wss.on('close', () => {
	clearInterval(heartbeatInterval);
});

const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
	console.log(`[signaling] WS listening on ${HOST}:${PORT}`);
});


