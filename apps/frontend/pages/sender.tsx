import { useEffect, useMemo, useRef, useState } from 'react';

// Sender page implementation
// - Requests camera permission and previews local video
// - Creates RTCPeerConnection and streams the video track
// - Opens an RTCDataChannel to send frame metadata: { frame_id, capture_ts }
// - Uses simple WebSocket signaling (room-based) per Phase 1

type JsonMessage = {
	type: string;
	[key: string]: any;
};

export default function SenderPage() {
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const wsRef = useRef<WebSocket | null>(null);
	const pcRef = useRef<RTCPeerConnection | null>(null);
	const dcRef = useRef<RTCDataChannel | null>(null);
	const streamRef = useRef<MediaStream | null>(null);
	const pendingTargetRef = useRef<string | null>(null); // last peer to negotiate with

	const frameIdRef = useRef<number>(0);
	const rafIdRef = useRef<number | null>(null);
	const lastSendTsRef = useRef<number>(0);

	const [status, setStatus] = useState<string>('idle');
	const [roomId, setRoomId] = useState<string>('room-1');
	const [peerId, setPeerId] = useState<string>(''); // set after mount to avoid SSR hydration mismatch
	const [errorText, setErrorText] = useState<string>('');

	// Read query params for overrides (room, signaling url)
	const config = useMemo(() => {
		if (typeof window === 'undefined') return { signalingUrl: 'ws://localhost:8080', room: 'room-1' };
		const url = new URL(window.location.href);
		const room = url.searchParams.get('room') || 'room-1';
		const signalingUrl = url.searchParams.get('sig') || 'ws://localhost:8080';
		return { signalingUrl, room };
	}, []);

	// Avoid SSR hydration mismatch by deferring display of signaling URL until after mount
	const [displaySigUrl, setDisplaySigUrl] = useState<string>('');

	useEffect(() => {
		setRoomId(config.room);
		setDisplaySigUrl(config.signalingUrl);
	}, [config.room, config.signalingUrl]);

	// Generate a stable peerId on the client only
	useEffect(() => {
		if (!peerId && typeof window !== 'undefined') {
			setPeerId(`sender-${Math.random().toString(36).slice(2, 8)}`);
		}
	}, [peerId]);

	useEffect(() => {
		if (!peerId) return; // wait until peerId is set on client
		let isMounted = true;

		async function initMedia() {
			try {
				// Warn for insecure context (most mobile browsers block camera on HTTP)
				if (typeof window !== 'undefined' && !window.isSecureContext) {
					setStatus('insecure-context');
					setErrorText('Browser blocked camera on HTTP. Use HTTPS or allow insecure origin in browser flags.');
				}
				setStatus('requesting-media');
				const media = await getMediaWithFallback();
				if (!isMounted) return;
				streamRef.current = media;
				if (videoRef.current) {
					videoRef.current.srcObject = media;
					videoRef.current.muted = true; // ensure no feedback
					videoRef.current.play().catch(() => {});
				}
				setStatus('media-ready');
				await initSignaling();
			} catch (err) {
				const e = err as any;
				console.error('[sender] getUserMedia error', e);
				setErrorText(`${e?.name || 'Error'}: ${e?.message || 'Failed to access camera'}`);
				setStatus('media-error');
			}
		}

		async function getMediaWithFallback(): Promise<MediaStream> {
			// Try a few descending constraint sets to maximize chance of success
			const attempts: MediaStreamConstraints[] = [
				{ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
				{ video: { facingMode: { ideal: 'environment' } }, audio: false },
				{ video: true, audio: false },
			];
			let lastErr: any = null;
			for (const constraints of attempts) {
				try {
					return await navigator.mediaDevices.getUserMedia(constraints);
				} catch (e) {
					lastErr = e;
				}
			}
			throw lastErr || new Error('getUserMedia failed for all constraints');
		}

		function createPeerConnection(): RTCPeerConnection {
			// Use public STUN servers for NAT traversal
			const pc = new RTCPeerConnection({
				iceServers: [
					{ urls: [
						'stun:stun.l.google.com:19302',
						'stun:stun1.l.google.com:19302',
						'stun:stun2.l.google.com:19302',
					] },
				],
			});

			pc.onicecandidate = (ev) => {
				if (ev.candidate && wsRef.current && pendingTargetRef.current) {
					const msg: JsonMessage = {
						type: 'candidate',
						targetPeerId: pendingTargetRef.current,
						candidate: ev.candidate,
					};
					wsRef.current.send(JSON.stringify(msg));
				}
			};

			pc.onconnectionstatechange = () => {
				console.log('[sender] pc state:', pc.connectionState);
				setStatus(`pc-${pc.connectionState}`);
			};

			pc.ondatachannel = (ev) => {
				// If remote creates a channel, accept it, but our sender normally initiates
				dcRef.current = ev.channel;
				wireDataChannel(dcRef.current);
			};

			// Attach local tracks immediately
			if (streamRef.current) {
				for (const track of streamRef.current.getTracks()) {
					pc.addTrack(track, streamRef.current);
				}
			}

			pcRef.current = pc;
			return pc;
		}

		function wireDataChannel(dc: RTCDataChannel) {
			dc.onopen = () => {
				setStatus('dc-open');
				startMetadataLoop();
			};
			dc.onclose = () => {
				setStatus('dc-closed');
				stopMetadataLoop();
			};
			dc.onerror = () => {
				setStatus('dc-error');
			};
		}

		function startMetadataLoop() {
			// Send at ~15 FPS; never queue >1 item: if bufferedAmount is high, skip this frame
			const targetIntervalMs = 1000 / 15;
			const loop = (now: number) => {
				rafIdRef.current = requestAnimationFrame(loop);
				const dc = dcRef.current;
				const pc = pcRef.current;
				if (!dc || !pc) return;
				if (dc.readyState !== 'open' || pc.connectionState !== 'connected') return;

				if (now - lastSendTsRef.current < targetIntervalMs) return;
				// Backpressure: drop if there is pending data buffered on the channel
				if (dc.bufferedAmount > 0) return;

				const payload = {
					frame_id: frameIdRef.current++,
					capture_ts: performance.now(),
				};
				try {
					dc.send(JSON.stringify(payload));
					lastSendTsRef.current = now;
				} catch (err) {
					// If send fails, drop this frame silently to avoid queuing
				}
			};
			rAFStart(loop);
		}

		function stopMetadataLoop() {
			if (rafIdRef.current != null) {
				cancelAnimationFrame(rafIdRef.current);
				rafIdRef.current = null;
			}
		}

		function rAFStart(cb: FrameRequestCallback) {
			rAFStop();
			rafIdRef.current = requestAnimationFrame(cb);
		}

		function rAFStop() {
			if (rafIdRef.current != null) {
				cancelAnimationFrame(rafIdRef.current);
				rafIdRef.current = null;
			}
		}

		async function createAndSendOffer(targetPeerId: string) {
			const pc = pcRef.current ?? createPeerConnection();
			// Sender initiates and owns a metadata channel named 'meta'
			if (!dcRef.current) {
				dcRef.current = pc.createDataChannel('meta', { ordered: true });
				wireDataChannel(dcRef.current);
			}
			pendingTargetRef.current = targetPeerId;
			const offer = await pc.createOffer();
			await pc.setLocalDescription(offer);
			console.log('[sender] sending offer to', targetPeerId);
			wsRef.current?.send(JSON.stringify({ type: 'offer', targetPeerId, sdp: offer.sdp }));
		}

		async function handleOffer(fromPeerId: string, sdp: string) {
			const pc = pcRef.current ?? createPeerConnection();
			pendingTargetRef.current = fromPeerId;
			await pc.setRemoteDescription({ type: 'offer', sdp });
			const answer = await pc.createAnswer();
			await pc.setLocalDescription(answer);
			console.log('[sender] sending answer to', fromPeerId);
			wsRef.current?.send(JSON.stringify({ type: 'answer', targetPeerId: fromPeerId, sdp: answer.sdp }));
		}

		async function handleAnswer(sdp: string) {
			const pc = pcRef.current;
			if (!pc) return;
			await pc.setRemoteDescription({ type: 'answer', sdp });
			console.log('[sender] received remote answer');
		}

		async function handleCandidate(candidate: RTCIceCandidateInit) {
			const pc = pcRef.current;
			if (!pc) return;
			try {
				await pc.addIceCandidate(candidate);
				console.log('[sender] added remote candidate');
			} catch (err) {
				console.warn('[sender] addIceCandidate failed', err);
			}
		}

		async function initSignaling() {
			setStatus('connecting-signal');
			const ws = new WebSocket(config.signalingUrl);
			wsRef.current = ws;

			ws.addEventListener('open', () => {
				setStatus('signal-open');
				const join: JsonMessage = { type: 'join', roomId: config.room, peerId };
				ws.send(JSON.stringify(join));
			});

			ws.addEventListener('message', async (ev) => {
				let msg: JsonMessage | null = null;
				try { msg = JSON.parse(ev.data); } catch { return; }
				if (!msg) return;
				switch (msg.type) {
					case 'joined': {
						setStatus('joined');
						// If peers already exist, attempt to negotiate with the first one
						const [firstPeer] = (msg.peers as string[]) || [];
						if (firstPeer) {
							createAndSendOffer(firstPeer);
						}
						break;
					}
					case 'peer-joined': {
						const target = msg.peerId as string;
						createAndSendOffer(target);
						break;
					}
					case 'offer': {
						await handleOffer(msg.fromPeerId, msg.sdp);
						break;
					}
					case 'answer': {
						await handleAnswer(msg.sdp);
						break;
					}
					case 'candidate': {
						await handleCandidate(msg.candidate);
						break;
					}
					case 'peer-left': {
						// If the peer we negotiated with left, allow renegotiation with the next joiner
						if (pendingTargetRef.current === msg.peerId) {
							pendingTargetRef.current = null;
						}
						break;
					}
					default:
						break;
				}
			});

			ws.addEventListener('close', () => setStatus('signal-closed'));
			ws.addEventListener('error', () => setStatus('signal-error'));
		}

		initMedia();

		return () => {
			isMounted = false;
			stopMetadataLoop();
			try { wsRef.current?.close(); } catch {}
			try { dcRef.current?.close(); } catch {}
			try { pcRef.current?.close(); } catch {}
			try { streamRef.current?.getTracks().forEach(t => t.stop()); } catch {}
		};
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [peerId]);

	return (
		<div style={{ padding: 16, fontFamily: 'sans-serif' }}>
			<h2>Sender</h2>
			<p>Room: <strong>{roomId}</strong></p>
			<p>Peer ID: <code>{peerId || '...'}</code></p>
			<p>Status: {status}</p>
			<video ref={videoRef} playsInline style={{ width: '100%', maxWidth: 480, background: '#000', borderRadius: 8 }} />
			{errorText && (
				<p style={{ color: '#b00020', whiteSpace: 'pre-wrap' }}>{errorText}</p>
			)}
			<p style={{ fontSize: 12, opacity: 0.7 }}>
				Signaling: <code>{displaySigUrl || '...'}</code>
			</p>
		</div>
	);
}


