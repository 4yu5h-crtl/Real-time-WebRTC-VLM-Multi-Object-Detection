const WebSocket = require('ws');

const WS_URL = process.env.WS_URL || 'ws://localhost:8080';
const ROOM_ID = process.env.ROOM_ID || 'room-1';
const VIEWER_ID = process.env.VIEWER_ID || 'viewer-test';

const ws = new WebSocket(WS_URL);
ws.on('open', () => {
	console.log('[viewer-test] connected to', WS_URL);
	ws.send(JSON.stringify({ type: 'join', roomId: ROOM_ID, peerId: VIEWER_ID }));
});
ws.on('message', (data) => {
	try {
		const msg = JSON.parse(data);
		console.log('[viewer-test] recv', msg);
	} catch {
		console.log('[viewer-test] raw', String(data));
	}
});

setTimeout(() => {
	console.log('[viewer-test] closing');
	try { ws.close(); } catch {}
	process.exit(0);
}, 15000);


