// Automated test to verify signaling relays offer/answer/candidate between two peers
const WebSocket = require('ws');

const WS_URL = process.env.WS_URL || 'ws://localhost:8080';
const ROOM_ID = 'test-room';
const SENDER_ID = 'sender';
const VIEWER_ID = 'viewer';

function waitForMessage(ws, predicate, timeoutMs = 5000) {
	return new Promise((resolve, reject) => {
		const onMessage = (data) => {
			try {
				const msg = JSON.parse(data);
				if (predicate(msg)) {
					cleanup();
					resolve(msg);
				}
			} catch (_) {}
		};
		const onError = (err) => { cleanup(); reject(err); };
		const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeoutMs);
		const cleanup = () => {
			clearTimeout(timer);
			ws.off('message', onMessage);
			ws.off('error', onError);
		};
		ws.on('message', onMessage);
		ws.on('error', onError);
	});
}

async function run() {
	const sender = new WebSocket(WS_URL);
	const viewer = new WebSocket(WS_URL);

	// Open both connections
	await Promise.all([
		new Promise((res) => sender.once('open', res)),
		new Promise((res) => viewer.once('open', res)),
	]);

	// Join room
	sender.send(JSON.stringify({ type: 'join', roomId: ROOM_ID, peerId: SENDER_ID }));
	viewer.send(JSON.stringify({ type: 'join', roomId: ROOM_ID, peerId: VIEWER_ID }));

	// Wait for joined responses
	await Promise.all([
		waitForMessage(sender, (m) => m.type === 'joined' && m.roomId === ROOM_ID && m.peerId === SENDER_ID),
		waitForMessage(viewer, (m) => m.type === 'joined' && m.roomId === ROOM_ID && m.peerId === VIEWER_ID),
	]);
	console.log('[test] both peers joined');

	// Sender -> Viewer: offer
	const offerSdp = 'OFFER_SDP';
	sender.send(JSON.stringify({ type: 'offer', targetPeerId: VIEWER_ID, sdp: offerSdp }));
	const gotOffer = await waitForMessage(viewer, (m) => m.type === 'offer' && m.fromPeerId === SENDER_ID && m.sdp === offerSdp);
	console.log('[test] viewer received offer:', gotOffer);

	// Viewer -> Sender: answer
	const answerSdp = 'ANSWER_SDP';
	viewer.send(JSON.stringify({ type: 'answer', targetPeerId: SENDER_ID, sdp: answerSdp }));
	const gotAnswer = await waitForMessage(sender, (m) => m.type === 'answer' && m.fromPeerId === VIEWER_ID && m.sdp === answerSdp);
	console.log('[test] sender received answer:', gotAnswer);

	// Sender -> Viewer: candidate
	const candidate = { candidate: 'a=candidate', sdpMid: '0', sdpMLineIndex: 0 };
	sender.send(JSON.stringify({ type: 'candidate', targetPeerId: VIEWER_ID, candidate }));
	const gotCandidate = await waitForMessage(viewer, (m) => m.type === 'candidate' && m.fromPeerId === SENDER_ID && m.candidate && m.candidate.candidate === 'a=candidate');
	console.log('[test] viewer received candidate:', gotCandidate);

	// Cleanup
	sender.close();
	viewer.close();
	console.log('[test] success');
	process.exit(0);
}

run().catch((err) => {
	console.error('[test] failure', err);
	process.exit(1);
});


