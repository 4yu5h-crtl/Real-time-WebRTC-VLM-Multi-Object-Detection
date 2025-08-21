import { useEffect, useMemo, useRef, useState } from 'react';
import * as ort from 'onnxruntime-web';

// Viewer page implementation (Phase 4: WASM inference complete)
// - Joins the same signaling room as the sender
// - Receives SDP offer, sets remote description, creates/send answer
// - Handles ICE candidates
// - Renders the remote video track into a <video>
// - Opens metadata channel and samples frames every 100ms
// - Runs WASM inference using onnxruntime-web with YOLO model
// - Overlays detection boxes with labels and confidence scores
// - Shows HUD with frame_id, latency, FPS, and inference status

type JsonMessage = {
	type: string;
	[key: string]: any;
};

export default function ViewerPage() {
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
	const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null); // 320x240 processing canvas
    const modelCanvasRef = useRef<HTMLCanvasElement | null>(null); // letterbox to model input size (e.g., 320x320)
	const containerRef = useRef<HTMLDivElement | null>(null); // wraps video + overlay for fullscreen
	const wsRef = useRef<WebSocket | null>(null);
	const pcRef = useRef<RTCPeerConnection | null>(null);
	const pendingSenderRef = useRef<string | null>(null);
	const metaChannelRef = useRef<RTCDataChannel | null>(null);
	const latestMetadataRef = useRef<{ frame_id: number; capture_ts: number; recv_ts: number } | null>(null);
	const rafIdRef = useRef<number | null>(null);
	// HUD smoothing
	const latencyEmaRef = useRef<number | null>(null);
	const displayedLatencyMsRef = useRef<number>(0);
	const displayedFrameIdRef = useRef<number>(0);
	const lastHudUpdateTsRef = useRef<number>(0);
	// Sampling control (every ~100ms) and FPS
	const isSamplingRef = useRef<boolean>(false);
	const lastSampleTsRef = useRef<number | null>(null);
	const sampleTimerRef = useRef<any>(null);
	const fpsEmaRef = useRef<number>(0);
	const displayedFpsRef = useRef<number>(0);
    // WASM inference
    const inferenceModeRef = useRef<string>('wasm');
    const ortSessionRef = useRef<ort.InferenceSession | null>(null);
    const isInferBusyRef = useRef<boolean>(false);
    const modelInputSizeRef = useRef<number>(320); // square size for model input, default 320
    const detectionsRef = useRef<Array<{
        label: string;
        score: number;
        xmin: number; ymin: number; xmax: number; ymax: number; // normalized 0..1
    }>>([]);
    // Stores how the 320x240 sample was letterboxed into the square model input
    const letterboxRef = useRef<{ dx: number; dy: number; drawW: number; drawH: number; modelSize: number } | null>(null);
    // Model loading and inference status
    const [modelStatus, setModelStatus] = useState<string>('not-loaded');
    const [inferenceTime, setInferenceTime] = useState<number>(0);
    const [detectionCount, setDetectionCount] = useState<number>(0);
    const modelStatusRef = useRef<string>('not-loaded');
    const inferenceTimeRef = useRef<number>(0);
    const detectionCountRef = useRef<number>(0);
	const frameDetectionsBufferRef = useRef<Map<number, {
		detections: Array<{ label: string; score: number; xmin: number; ymin: number; xmax: number; ymax: number; }>;
		inference_ts: number;
	}>>(new Map());

	// Phase 6: metrics aggregation (latency, fps, bandwidth)
	const metricsRef = useRef<{
		running: boolean;
		startTsMs: number;
		e2eLatencies: number[];
		networkLatencies: number[];
		serverLatencies: number[];
		processedFps: number[];
		uplinkKbps: number[];
		downlinkKbps: number[];
		lastInferenceTs: number | null;
		lastBytes: { sent: number; received: number; ts: number } | null;
	}>({
		running: false,
		startTsMs: 0,
		e2eLatencies: [],
		networkLatencies: [],
		serverLatencies: [],
		processedFps: [],
		uplinkKbps: [],
		downlinkKbps: [],
		lastInferenceTs: null,
		lastBytes: null,
	});

	const statsTimerRef = useRef<any>(null);

	function startMetrics() {
		metricsRef.current.running = true;
		metricsRef.current.startTsMs = performance.now();
		metricsRef.current.e2eLatencies = [];
		metricsRef.current.networkLatencies = [];
		metricsRef.current.serverLatencies = [];
		metricsRef.current.processedFps = [];
		metricsRef.current.uplinkKbps = [];
		metricsRef.current.downlinkKbps = [];
		metricsRef.current.lastInferenceTs = null;
		metricsRef.current.lastBytes = null;
		// Bandwidth sampling each second
		if (statsTimerRef.current) clearInterval(statsTimerRef.current);
		statsTimerRef.current = setInterval(async () => {
			const pc = pcRef.current;
			if (!pc) return;
			try {
				const stats = await pc.getStats(null);
				let bytesSent = 0, bytesRecv = 0;
				stats.forEach((r: any) => {
					if (r.type === 'outbound-rtp' && r.bytesSent != null) bytesSent += r.bytesSent;
					if (r.type === 'inbound-rtp' && r.bytesReceived != null) bytesRecv += r.bytesReceived;
				});
				const now = performance.now();
				const prev = metricsRef.current.lastBytes;
				if (prev) {
					const dtSec = Math.max(0.001, (now - prev.ts) / 1000);
					const upKbps = ((bytesSent - prev.sent) * 8) / 1000 / dtSec;
					const downKbps = ((bytesRecv - prev.received) * 8) / 1000 / dtSec;
					metricsRef.current.uplinkKbps.push(upKbps);
					metricsRef.current.downlinkKbps.push(downKbps);
				}
				metricsRef.current.lastBytes = { sent: bytesSent, received: bytesRecv, ts: now };
			} catch {}
		}, 1000);

		// Optional timed bench run
		const benchMs = (config as any).bench > 0 ? ((config as any).bench * 1000) : 0;
		if (benchMs > 0) {
			setTimeout(() => {
				stopMetricsAndDownload();
			}, benchMs);
		}
	}

	function stopMetricsAndDownload() {
		metricsRef.current.running = false;
		if (statsTimerRef.current) { clearInterval(statsTimerRef.current); statsTimerRef.current = null; }
		const compute = (arr: number[]) => {
			const a = arr.slice().filter(n => Number.isFinite(n)).sort((x, y) => x - y);
			if (a.length === 0) return { median: 0, p95: 0 };
			const median = a[Math.floor(a.length / 2)];
			const p95 = a[Math.floor(a.length * 0.95) - 1] ?? a[a.length - 1];
			return { median, p95 };
		};
		const payload = {
			mode: inferenceModeRef.current,
			duration_ms: Math.max(0, performance.now() - metricsRef.current.startTsMs),
			counts: {
				e2e: metricsRef.current.e2eLatencies.length,
				network: metricsRef.current.networkLatencies.length,
				server: metricsRef.current.serverLatencies.length,
				fps: metricsRef.current.processedFps.length,
				bw: metricsRef.current.uplinkKbps.length,
			},
			latency_e2e: compute(metricsRef.current.e2eLatencies),
			latency_network: compute(metricsRef.current.networkLatencies),
			latency_server: compute(metricsRef.current.serverLatencies),
			fps_processed: compute(metricsRef.current.processedFps),
			uplink_kbps: compute(metricsRef.current.uplinkKbps),
			downlink_kbps: compute(metricsRef.current.downlinkKbps),
		};
		const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = 'metrics.json';
		a.click();
		URL.revokeObjectURL(a.href);
	}

	const [status, setStatus] = useState<string>('idle');
	const [roomId, setRoomId] = useState<string>('room-1');
	const [peerId, setPeerId] = useState<string>(''); // set after mount to avoid SSR mismatch
	const [displaySigUrl, setDisplaySigUrl] = useState<string>('');
	const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

	const config = useMemo(() => {
		if (typeof window === 'undefined') return { signalingUrl: 'ws://localhost:8080', room: 'room-1', mode: 'wasm' };
		const url = new URL(window.location.href);
		const room = url.searchParams.get('room') || 'room-1';
		const signalingUrl = url.searchParams.get('sig') || 'ws://localhost:8080';
		const mode = url.searchParams.get('mode') || 'wasm';
		const serverUrl = url.searchParams.get('server') || 'ws://localhost:8000/detect';
		const bench = Number(url.searchParams.get('bench') || '0');
		return { signalingUrl, room, mode, serverUrl, bench } as any;
	}, []);

	useEffect(() => {
		setRoomId(config.room);
		setDisplaySigUrl(config.signalingUrl);
		// set inference mode from query param (wasm/server)
		inferenceModeRef.current = (config as any).mode || 'wasm';
	}, [config.room, config.signalingUrl]);

	// Keep refs in sync for HUD and sampling loops
	useEffect(() => { modelStatusRef.current = modelStatus; }, [modelStatus]);
	useEffect(() => { inferenceTimeRef.current = inferenceTime; }, [inferenceTime]);
	useEffect(() => { detectionCountRef.current = detectionCount; }, [detectionCount]);

	// Generate a stable peerId on the client only
	useEffect(() => {
		if (!peerId && typeof window !== 'undefined') {
			setPeerId(`viewer-${Math.random().toString(36).slice(2, 8)}`);
		}
	}, [peerId]);

	useEffect(() => {
		if (!peerId) return;
		let isMounted = true;

		// Keep overlay sized during window resize/fullscreen changes
		const onResize = () => {
			syncCanvasToVideoSize();
			if (typeof document !== 'undefined') {
				setIsFullscreen(!!document.fullscreenElement);
			}
		};
		window.addEventListener('resize', onResize);
		document.addEventListener('fullscreenchange', onResize);

		function createPeerConnection(): RTCPeerConnection {
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
				if (ev.candidate && wsRef.current && pendingSenderRef.current) {
					const msg: JsonMessage = { type: 'candidate', targetPeerId: pendingSenderRef.current, candidate: ev.candidate };
					wsRef.current.send(JSON.stringify(msg));
				}
			};

			pc.onconnectionstatechange = () => {
				console.log('[viewer] pc state:', pc.connectionState);
				setStatus(`pc-${pc.connectionState}`);
			};

			pc.ontrack = (ev) => {
				// Attach the first stream to the video element
				const [stream] = ev.streams;
				if (videoRef.current && stream) {
					videoRef.current.srcObject = stream;
					videoRef.current.play().catch(() => {});
					// Sync canvas size to incoming video once metadata is known
					videoRef.current.onloadedmetadata = () => syncCanvasToVideoSize();
					startOverlayLoop();
					startSamplingLoop();
					// Pre-load model when video is ready
					if (inferenceModeRef.current === 'wasm') {
						preloadModel();
					}
					// Auto-start metrics if bench param provided
					if ((config as any).bench > 0) {
						startMetrics();
					}
				}
			};

			pc.ondatachannel = (ev) => {
				// Sender's 'meta' channel (frame_id, capture_ts)
				metaChannelRef.current = ev.channel;
				metaChannelRef.current.onmessage = (e) => {
					try {
						const msg = JSON.parse(e.data) as { frame_id: number; capture_ts: number };
						latestMetadataRef.current = {
							frame_id: msg.frame_id,
							capture_ts: msg.capture_ts,
							recv_ts: performance.now(),
						};
						// collect network latency recv_ts - capture_ts
						if (metricsRef.current.running) {
							const meta = latestMetadataRef.current;
							const net = Math.max(0, meta.recv_ts - meta.capture_ts);
							if (Number.isFinite(net)) metricsRef.current.networkLatencies.push(net);
						}
					} catch {}
				};
			};

			pcRef.current = pc;
			return pc;
		}

		async function handleOffer(fromPeerId: string, sdp: string) {
			const pc = pcRef.current ?? createPeerConnection();
			pendingSenderRef.current = fromPeerId;
			await pc.setRemoteDescription({ type: 'offer', sdp });
			const answer = await pc.createAnswer();
			await pc.setLocalDescription(answer);
			console.log('[viewer] sending answer to', fromPeerId);
			wsRef.current?.send(JSON.stringify({ type: 'answer', targetPeerId: fromPeerId, sdp: answer.sdp }));
		}

		async function handleCandidate(candidate: RTCIceCandidateInit) {
			const pc = pcRef.current;
			if (!pc) return;
			try { await pc.addIceCandidate(candidate); console.log('[viewer] added remote candidate'); } catch (e) {
				console.warn('[viewer] addIceCandidate failed', e);
			}
		}

		function initSignaling() {
			setStatus('connecting-signal');
			const ws = new WebSocket(config.signalingUrl);
			wsRef.current = ws;

			ws.addEventListener('open', () => {
				setStatus('signal-open');
				ws.send(JSON.stringify({ type: 'join', roomId: config.room, peerId } as JsonMessage));
			});

			ws.addEventListener('message', async (ev) => {
				let msg: JsonMessage | null = null;
				try { msg = JSON.parse(ev.data); } catch { return; }
				if (!msg) return;
				switch (msg.type) {
					case 'joined': {
						setStatus('joined');
						break;
					}
					case 'offer': {
						await handleOffer(msg.fromPeerId, msg.sdp);
						break;
					}
					case 'candidate': {
						await handleCandidate(msg.candidate);
						break;
					}
					case 'peer-left': {
						if (pendingSenderRef.current === msg.peerId) pendingSenderRef.current = null;
						break;
					}
					default:
						break;
				}
			});

			ws.addEventListener('close', () => setStatus('signal-closed'));
			ws.addEventListener('error', () => setStatus('signal-error'));
		}

		initSignaling();

		return () => {
			isMounted = false;
			try { wsRef.current?.close(); } catch {}
			try { pcRef.current?.close(); } catch {}
			stopOverlayLoop();
			stopSamplingLoop();
			window.removeEventListener('resize', onResize);
			document.removeEventListener('fullscreenchange', onResize);
		};
	}, [peerId, config.signalingUrl, config.room]);

	// Keep overlay canvas sized and positioned to exactly match displayed video area
	function syncCanvasToVideoSize() {
		const video = videoRef.current;
		const canvas = overlayCanvasRef.current;
		const container = containerRef.current;
		if (!video || !canvas || !container) return;

		const containerRect = container.getBoundingClientRect();
		const intrinsicW = video.videoWidth || containerRect.width;
		const intrinsicH = video.videoHeight || containerRect.height;

		let targetW = Math.floor(containerRect.width);
		let targetH = Math.floor(containerRect.height);
		if (intrinsicW && intrinsicH && containerRect.width && containerRect.height) {
			const scale = Math.min(containerRect.width / intrinsicW, containerRect.height / intrinsicH);
			targetW = Math.max(1, Math.round(intrinsicW * scale));
			targetH = Math.max(1, Math.round(intrinsicH * scale));
		}

		const left = Math.round((containerRect.width - targetW) / 2);
		const top = Math.round((containerRect.height - targetH) / 2);

		if (canvas.width !== targetW) canvas.width = targetW;
		if (canvas.height !== targetH) canvas.height = targetH;

		const style = canvas.style as CSSStyleDeclaration;
		style.width = `${targetW}px`;
		style.height = `${targetH}px`;
		style.left = `${left}px`;
		style.top = `${top}px`;
	}

	async function toggleFullscreen() {
		const el = containerRef.current;
		if (!el) return;
		if (typeof document !== 'undefined' && !document.fullscreenElement) {
			await el.requestFullscreen().catch(() => {});
		} else {
			await document.exitFullscreen().catch(() => {});
		}
		syncCanvasToVideoSize();
		if (typeof document !== 'undefined') {
			setIsFullscreen(!!document.fullscreenElement);
		}
	}

	// Overlay render loop draws HUD and any available overlays
	function startOverlayLoop() {
		stopOverlayLoop();
		const render = () => {
			rafIdRef.current = requestAnimationFrame(render);
			syncCanvasToVideoSize();
			const canvas = overlayCanvasRef.current;
			if (!canvas) return;
			const ctx = canvas.getContext('2d');
			if (!ctx) return;
			ctx.clearRect(0, 0, canvas.width, canvas.height);

			// Draw HUD with frame_id, smoothed end-to-end latency, FPS, and model status
			const meta = latestMetadataRef.current;
			if (meta) {
				const now = performance.now();
				const instLatencyMs = Math.max(0, now - meta.capture_ts);
				// Exponential moving average to smooth rapid changes
				const alpha = 0.2; // smoothing factor (higher = more reactive)
				if (latencyEmaRef.current == null) latencyEmaRef.current = instLatencyMs;
				else latencyEmaRef.current = alpha * instLatencyMs + (1 - alpha) * latencyEmaRef.current;

				// Update HUD numbers at most 5 times per second to reduce flicker
				if (now - lastHudUpdateTsRef.current >= 200) {
					lastHudUpdateTsRef.current = now;
					displayedLatencyMsRef.current = latencyEmaRef.current;
					displayedFrameIdRef.current = meta.frame_id;
					// Metrics collection (Phase 6)
					if (metricsRef.current.running) {
						metricsRef.current.e2eLatencies.push(displayedLatencyMsRef.current);
						metricsRef.current.processedFps.push(displayedFpsRef.current);
					}
				}

				// Draw detections for the current frame_id if available
				const bufferedDetections = frameDetectionsBufferRef.current.get(meta.frame_id);
				if (bufferedDetections) {
					detectionsRef.current = bufferedDetections.detections; // Update ref for display
					setDetectionCount(detectionsRef.current.length);
					setInferenceTime(bufferedDetections.inference_ts);
					metricsRef.current.lastInferenceTs = bufferedDetections.inference_ts;
					frameDetectionsBufferRef.current.delete(meta.frame_id); // Consume it
				} else {
					detectionsRef.current = []; // No matching detections, clear previous
				}

				// HUD background
				ctx.fillStyle = 'rgba(0,0,0,0.6)';
				ctx.fillRect(8, 8, 340, 140);
				
				// HUD text
				ctx.fillStyle = '#00FF88';
				ctx.font = '14px monospace';
				ctx.fillText(`frame_id: ${displayedFrameIdRef.current}`, 16, 28);
				ctx.fillText(`e2e latency: ${displayedLatencyMsRef.current.toFixed(1)} ms`, 16, 48);
				ctx.fillText(`fps: ${displayedFpsRef.current.toFixed(1)}`, 16, 68);
				ctx.fillText(`model: ${modelStatusRef.current}`, 16, 88);
				ctx.fillText(`inference: ${inferenceTimeRef.current.toFixed(1)}ms`, 16, 108);
				if (metricsRef.current.running) {
					ctx.fillText('REC metrics...', 16, 128);
				}
			}

			// Draw detection boxes if any (green outlines with labels)
			const dets = detectionsRef.current;
			if (dets && dets.length > 0) {
				for (const d of dets) {
					const x = d.xmin * canvas.width;
					const y = d.ymin * canvas.height;
					const w = (d.xmax - d.xmin) * canvas.width;
					const h = (d.ymax - d.ymin) * canvas.height;
					
					// Box outline
					ctx.strokeStyle = '#00FF88';
					ctx.lineWidth = 2;
					ctx.strokeRect(x, y, w, h);
					
					// Label background
					const label = `${d.label} ${(d.score * 100).toFixed(0)}%`;
					const pad = 4;
					const labelWidth = ctx.measureText(label).width + 2 * pad;
					ctx.fillStyle = 'rgba(0,0,0,0.8)';
					ctx.fillRect(x, Math.max(0, y - 18), Math.min(canvas.width - x, labelWidth), 18);
					
					// Label text
					ctx.fillStyle = '#00FF88';
					ctx.font = '12px monospace';
					ctx.fillText(label, x + pad, Math.max(12, y - 4));
				}
			}
		};
		render();
	}

	function stopOverlayLoop() {
		if (rafIdRef.current != null) {
			cancelAnimationFrame(rafIdRef.current);
			rafIdRef.current = null;
		}
	}

	// Sample frames every ~100ms into a 320x240 canvas
	function startSamplingLoop() {
		stopSamplingLoop();
		const ensureCanvas = () => {
			let canvas = sampleCanvasRef.current;
			if (!canvas) {
				canvas = document.createElement('canvas');
				sampleCanvasRef.current = canvas;
			}
			if (canvas.width !== 320) canvas.width = 320;
			if (canvas.height !== 240) canvas.height = 240;
			return canvas;
		};
		sampleTimerRef.current = setInterval(async () => {
			if (isSamplingRef.current) return; // backpressure: never queue >1
			const video = videoRef.current;
			const canvas = ensureCanvas();
			if (!video || !canvas) return;
			const ctx = canvas.getContext('2d');
			if (!ctx || video.readyState < 2) return; // HAVE_CURRENT_DATA
			isSamplingRef.current = true;
			try {
				ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
				// Update FPS using instantaneous interval
				const now = performance.now();
				if (lastSampleTsRef.current != null) {
					const dt = now - lastSampleTsRef.current;
					if (dt > 0) {
						const instFps = 1000 / dt;
						const alpha = 0.2;
						fpsEmaRef.current = fpsEmaRef.current ? (alpha * instFps + (1 - alpha) * fpsEmaRef.current) : instFps;
					}
				}
				lastSampleTsRef.current = now;
				// Throttle HUD updates for FPS in the same cadence as latency
				if (now - lastHudUpdateTsRef.current >= 200) {
					displayedFpsRef.current = fpsEmaRef.current;
				}

				// WASM inference path (mode=wasm)
				if (inferenceModeRef.current === 'wasm' && modelStatusRef.current === 'ready') {
					maybeRunWasmInference(canvas, latestMetadataRef.current);
				}
				// Server inference path (mode=server)
				if (inferenceModeRef.current === 'server') {
					await ensureServerSocket();
					if (!isServerBusyRef.current && serverWsRef.current && serverWsRef.current.readyState === WebSocket.OPEN) {
						isServerBusyRef.current = true;
						const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
						const meta = latestMetadataRef.current;
						serverWsRef.current.send(JSON.stringify({
							frame_id: meta?.frame_id ?? -1,
							capture_ts: meta?.capture_ts ?? performance.now(),
							image_b64: dataUrl
						}));
					}
				}
			} finally {
				isSamplingRef.current = false;
			}
		}, 100);
	}

	function stopSamplingLoop() {
		if (sampleTimerRef.current) {
			clearInterval(sampleTimerRef.current);
			sampleTimerRef.current = null;
		}
		isSamplingRef.current = false;
	}

    // ========================= Server Inference (FastAPI) - Phase 5 =========================
    const serverWsRef = useRef<WebSocket | null>(null);
    const isServerBusyRef = useRef<boolean>(false);

    async function ensureServerSocket() {
        if (serverWsRef.current && serverWsRef.current.readyState === WebSocket.OPEN) return;
        await new Promise<void>((resolve) => {
            try { serverWsRef.current?.close(); } catch {}
            const ws = new WebSocket((config as any).serverUrl);
            serverWsRef.current = ws;
            ws.onopen = () => resolve();
            ws.onmessage = (ev) => {
                try {
                    const msg = JSON.parse(ev.data);
                    if (typeof msg.inference_ms === 'number') setInferenceTime(msg.inference_ms);
                    
                    // Collect server latency metrics (server_recv_ts → inference_ts)
                    if (typeof msg.server_recv_ts === 'number' && typeof msg.inference_ts === 'number') {
                        const serverLatency = msg.inference_ts - msg.server_recv_ts;
                        if (metricsRef.current.running && Number.isFinite(serverLatency)) {
                            metricsRef.current.serverLatencies.push(serverLatency);
                        }
                    }
                    
                    if (Array.isArray(msg.detections)) {
                        // map numeric labels to COCO names for readability
                        const labels = ['person','bicycle','car','motorcycle','airplane','bus','train','truck','boat','traffic light','fire hydrant','stop sign','parking meter','bench','bird','cat','dog','horse','sheep','cow','elephant','bear','zebra','giraffe','backpack','umbrella','handbag','tie','suitcase','frisbee','skis','snowboard','sports ball','kite','baseball bat','baseball glove','skateboard','surfboard','tennis racket','bottle','wine glass','cup','fork','knife','spoon','bowl','banana','apple','sandwich','orange','broccoli','carrot','hot dog','pizza','donut','cake','chair','couch','potted plant','bed','dining table','toilet','tv','laptop','mouse','remote','keyboard','cell phone','microwave','oven','toaster','sink','refrigerator','book','clock','vase','scissors','teddy bear','hair drier','toothbrush'];
                        // Buffer detections by frame_id for strict alignment
                        frameDetectionsBufferRef.current.set(msg.frame_id, { detections: msg.detections, inference_ts: msg.inference_ts });
                    }
                } catch {}
                isServerBusyRef.current = false;
            };
            ws.onerror = () => { isServerBusyRef.current = false; };
            ws.onclose = () => { isServerBusyRef.current = false; };
        });
    }

    // ========================= WASM Inference (onnxruntime-web) - Phase 4 Complete =========================
    
    // Preload model when video is ready
    async function preloadModel() {
        try {
            setModelStatus('loading');
            console.log('[viewer] Starting model preload...');
            await ensureOrtSession();
            setModelStatus('ready');
            console.log('[viewer] WASM model loaded successfully');
        } catch (error) {
            console.error('[viewer] Model loading failed:', error);
            setModelStatus('failed');
            // Show more detailed error info
            if (error instanceof Error) {
                console.error('[viewer] Error details:', {
                    message: error.message,
                    stack: error.stack,
                    name: error.name
                });
            }
        }
    }

    async function maybeRunWasmInference(sampleCanvas: HTMLCanvasElement, meta: { frame_id: number; capture_ts: number; recv_ts: number } | null) {
        if (isInferBusyRef.current) return; // drop if busy (backpressure)
        const session = ortSessionRef.current;
        if (!session) return;
        
        isInferBusyRef.current = true;
        try {
            const inputTensor = await preprocessToTensor(sampleCanvas, modelInputSizeRef.current);
            const feeds: Record<string, ort.Tensor> = {};
            feeds[session.inputNames[0]] = inputTensor;
            
            const t0 = performance.now();
            const results = await session.run(feeds);
            const t1 = performance.now();
            
            const inferenceMs = t1 - t0;
            setInferenceTime(inferenceMs);
            
            // Decode detections from outputs
            const decoded = decodeDetections(results, sampleCanvas.width, sampleCanvas.height);
            // Apply NMS and limit
            const final = nonMaxSuppression(decoded, 0.45, 0.25, 50);
            detectionsRef.current = final;
            setDetectionCount(final.length);
            
            // Buffer detections by frame_id for strict alignment
            if (meta) {
                frameDetectionsBufferRef.current.set(meta.frame_id, { detections: final, inference_ts: inferenceMs });
            }
            
            console.log(`[wasm] inference ${inferenceMs.toFixed(1)}ms, dets ${final.length}`);
        } catch (e) {
            console.warn('[wasm] inference error:', e);
            detectionsRef.current = [];
            setDetectionCount(0);
        } finally {
            isInferBusyRef.current = false;
        }
    }

    async function ensureOrtSession() {
        if (ortSessionRef.current) return;
        
        console.log('[viewer] ensureOrtSession: Starting...');
        
        // Configure WASM with more reliable settings
        try {
            // Force single-threaded and basic WASM to avoid complex CDN dependencies
            ort.env.wasm.numThreads = 1;
            ort.env.wasm.simd = false; // Disable SIMD to avoid complex WASM files
            ort.env.wasm.proxy = false;
            
            // Use a more reliable approach - let onnxruntime-web handle its own paths
            // but override with working alternatives if needed
            const wasmPaths = [
                '/ort/', // Prefer local files if available
                'https://unpkg.com/onnxruntime-web@1.17.3/dist/',
                'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/',
                'https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.17.3/',
            ];
            
            let wasmPathFound = false;
            // Test each path and use the first working one
            for (const path of wasmPaths) {
                try {
                    // Test with a simpler WASM file that should exist
                    const testUrl = `${path}ort-wasm.wasm`;
                    const response = await fetch(testUrl, { method: 'HEAD' });
                    if (response.ok) {
                        ort.env.wasm.wasmPaths = path;
                        console.log('[viewer] Using WASM path:', path);
                        wasmPathFound = true;
                        break;
                    }
                } catch (e) {
                    console.warn('[viewer] WASM path failed:', path, e);
                }
            }
            
            if (!wasmPathFound) {
                console.warn('[viewer] All CDN paths failed, trying default onnxruntime-web paths');
                // Let onnxruntime-web use its built-in default paths
            }
            
            console.log('[viewer] WASM config set:', {
                numThreads: ort.env.wasm.numThreads,
                simd: ort.env.wasm.simd,
                wasmPaths: ort.env.wasm.wasmPaths
            });
        } catch (e) {
            console.warn('[viewer] WASM config failed:', e);
        }
        
        const modelUrl = '/models/model.onnx';
        console.log('[viewer] Loading model from:', modelUrl);
        
        try {
            // Test if the model file is accessible
            const response = await fetch(modelUrl);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            const modelSize = response.headers.get('content-length');
            console.log('[viewer] Model file accessible, size:', modelSize, 'bytes');
        } catch (fetchError) {
            console.error('[viewer] Model file fetch failed:', fetchError);
            const errorMessage = fetchError && typeof fetchError === 'object' && 'message' in fetchError 
                ? (fetchError as any).message 
                : String(fetchError);
            throw new Error(`Cannot access model file: ${errorMessage}`);
        }
        
        try {
            // Try to create session with minimal options to avoid WASM issues
            const session = await ort.InferenceSession.create(modelUrl, {
                executionProviders: ['wasm'],
                graphOptimizationLevel: 'basic', // Use basic optimization
                enableCpuMemArena: false,
                enableMemPattern: false,
                // Force basic WASM loader names that we downloaded locally
                // Note: onnxruntime-web uses internal mapping; setting wasmPaths above is key
            });
            
            ortSessionRef.current = session;
            console.log('[viewer] Model loaded, input names:', session.inputNames);
            console.log('[viewer] Model input metadata:', (session.inputMetadata as any));
            
            // Infer input size from metadata
            try {
                const inputName = session.inputNames[0];
                const inputMeta = (session.inputMetadata as any)[inputName];
                const dims = (inputMeta as any)?.dimensions || [];
                const size = Math.max(Number(dims[dims.length - 1]), Number(dims[dims.length - 2])) || 320;
                if (Number.isFinite(size)) {
                    modelInputSizeRef.current = size;
                    console.log('[viewer] Model input size:', size);
                }
            } catch (metaError) {
                console.warn('[viewer] Could not parse input metadata:', metaError);
            }
            
            // Prepare model canvas
            if (!modelCanvasRef.current) modelCanvasRef.current = document.createElement('canvas');
            modelCanvasRef.current.width = modelInputSizeRef.current;
            modelCanvasRef.current.height = modelInputSizeRef.current;
            
            console.log('[viewer] Model session created successfully');
        } catch (sessionError) {
            console.error('[viewer] Session creation failed:', sessionError);
            
            // If WASM fails, try to provide a more helpful error message
            if (sessionError && typeof sessionError === 'object' && 'message' in sessionError && 
                typeof (sessionError as any).message === 'string' && 
                (sessionError as any).message.includes('no available backend')) {
                throw new Error('WASM backend failed to initialize. This might be due to browser compatibility or network issues. Try refreshing the page or using a different browser.');
            }
            
            throw sessionError;
        }
    }

    async function preprocessToTensor(sampleCanvas: HTMLCanvasElement, modelSize: number): Promise<ort.Tensor> {
        // Letterbox the 320x240 sample into a square modelSize x modelSize canvas, preserving aspect with padding
        const modelCanvas = modelCanvasRef.current!;
        const ctx = modelCanvas.getContext('2d')!;

        // Fill with black padding
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, modelSize, modelSize);

        // Calculate letterbox dimensions
        const srcW = sampleCanvas.width;
        const srcH = sampleCanvas.height;
        const scale = Math.min(modelSize / srcW, modelSize / srcH);
        const drawW = Math.round(srcW * scale);
        const drawH = Math.round(srcH * scale);
        const dx = Math.floor((modelSize - drawW) / 2);
        const dy = Math.floor((modelSize - drawH) / 2);

        // Store mapping so we can unletterbox predictions back to source space
        letterboxRef.current = { dx, dy, drawW, drawH, modelSize };

        // Draw the image centered
        ctx.drawImage(sampleCanvas, 0, 0, srcW, srcH, dx, dy, drawW, drawH);

        // Read pixels and convert to tensor
        const imgData = ctx.getImageData(0, 0, modelSize, modelSize);
        const { data } = imgData; // RGBA

        // Convert to Float32 [1,3,H,W] normalized 0..1
        const floatData = new Float32Array(1 * 3 * modelSize * modelSize);
        const plane = modelSize * modelSize;

        for (let i = 0; i < modelSize * modelSize; i++) {
            const r = data[i * 4] / 255;
            const g = data[i * 4 + 1] / 255;
            const b = data[i * 4 + 2] / 255;
            floatData[i] = r;
            floatData[i + plane] = g;
            floatData[i + plane * 2] = b;
        }

        return new ort.Tensor('float32', floatData, [1, 3, modelSize, modelSize]);
    }

    function decodeDetections(results: Record<string, ort.Tensor>, srcW: number, srcH: number): Array<{ label: string; score: number; xmin: number; ymin: number; xmax: number; ymax: number; }> {
        // YOLOv8 ONNX usually outputs [1,84,8400] (channels-first). 84 = 4 box + 80 classes
        const firstName = Object.keys(results)[0];
        const out = results[firstName];
        const outData = out.data as unknown as Float32Array;
        const dims: number[] = (out as any).dims || (out as any).dimensions || [];

        const detections: Array<{ label: string; score: number; xmin: number; ymin: number; xmax: number; ymax: number; }> = [];
        if (!outData || outData.length === 0) return detections;

        const labels = ['person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket', 'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush'];

        // If dims like [1,84,8400]
        if (dims.length === 3 && dims[1] >= 6) {
            const numClasses = dims[1] - 4;
            const numProps = dims[2];
            const getVal = (c: number, k: number) => outData[c * numProps + k];

            const map = letterboxRef.current;
            const dx = map?.dx ?? 0; const dy = map?.dy ?? 0; const drawW = map?.drawW ?? modelInputSizeRef.current; const drawH = map?.drawH ?? modelInputSizeRef.current; const modelSize = map?.modelSize ?? modelInputSizeRef.current;

            for (let k = 0; k < numProps; k++) {
                const cx = getVal(0, k);
                const cy = getVal(1, k);
                const w = getVal(2, k);
                const h = getVal(3, k);

                // class probs
                let bestScore = 0; let bestClass = -1;
                for (let c = 0; c < numClasses; c++) {
                    const s = getVal(4 + c, k);
                    if (s > bestScore) { bestScore = s; bestClass = c; }
                }
                if (bestScore < 0.25) continue;

                // xywh(center) -> xyxy in model space (pixels)
                let x1 = cx - w / 2;
                let y1 = cy - h / 2;
                let x2 = cx + w / 2;
                let y2 = cy + h / 2;

                // Unletterbox: remove padding and scale back to source canvas (320x240)
                x1 = (x1 - dx) / drawW * srcW;
                y1 = (y1 - dy) / drawH * srcH;
                x2 = (x2 - dx) / drawW * srcW;
                y2 = (y2 - dy) / drawH * srcH;

                // Normalize 0..1 for overlay scaling
                const nx1 = Math.min(1, Math.max(0, x1 / srcW));
                const ny1 = Math.min(1, Math.max(0, y1 / srcH));
                const nx2 = Math.min(1, Math.max(0, x2 / srcW));
                const ny2 = Math.min(1, Math.max(0, y2 / srcH));
                if (nx2 <= nx1 || ny2 <= ny1) continue;

                detections.push({ label: labels[bestClass] || `cls${bestClass}`, score: bestScore, xmin: nx1, ymin: ny1, xmax: nx2, ymax: ny2 });
            }
            return detections;
        }

        // Fallback: treat as [N,6]
        const n = Math.floor(outData.length / 6);
        for (let i = 0; i < n; i++) {
            const base = i * 6;
            const x1 = Number(outData[base + 0]);
            const y1 = Number(outData[base + 1]);
            const x2 = Number(outData[base + 2]);
            const y2 = Number(outData[base + 3]);
            const score = Number(outData[base + 4]);
            const cls = Number(outData[base + 5]);
            if (score < 0.25) continue;
            const nx1 = Math.min(1, Math.max(0, x1 / srcW));
            const ny1 = Math.min(1, Math.max(0, y1 / srcH));
            const nx2 = Math.min(1, Math.max(0, x2 / srcW));
            const ny2 = Math.min(1, Math.max(0, y2 / srcH));
            if (nx2 <= nx1 || ny2 <= ny1) continue;
            detections.push({ label: labels[cls] || `cls${cls}`, score, xmin: nx1, ymin: ny1, xmax: nx2, ymax: ny2 });
        }
        return detections;
    }

    function iou(a: { xmin: number; ymin: number; xmax: number; ymax: number; }, b: { xmin: number; ymin: number; xmax: number; ymax: number; }) {
        const x1 = Math.max(a.xmin, b.xmin);
        const y1 = Math.max(a.ymin, b.ymin);
        const x2 = Math.min(a.xmax, b.xmax);
        const y2 = Math.min(a.ymax, b.ymax);
        const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
        const areaA = Math.max(0, a.xmax - a.xmin) * Math.max(0, a.ymax - a.ymin);
        const areaB = Math.max(0, b.xmax - b.xmin) * Math.max(0, b.ymax - b.ymin);
        const union = areaA + areaB - inter;
        return union <= 0 ? 0 : inter / union;
    }

    function nonMaxSuppression(dets: Array<{ label: string; score: number; xmin: number; ymin: number; xmax: number; ymax: number; }>, iouThresh: number, scoreThresh: number, maxDet: number) {
        const filtered = dets.filter(d => d.score >= scoreThresh).sort((a, b) => b.score - a.score);
        const keep: typeof filtered = [];
        
        for (const d of filtered) {
            let ok = true;
            for (const k of keep) {
                if (iou(d, k) > iouThresh) { 
                    ok = false; 
                    break; 
                }
            }
            if (ok) {
                keep.push(d);
                if (keep.length >= maxDet) break;
            }
        }
        
        return keep;
    }

	return (
		<div style={{ padding: 16, fontFamily: 'sans-serif' }}>
			<h2>Viewer - Phase 4: WASM Inference Complete</h2>
			<p>Room: <strong>{roomId}</strong></p>
			<p>Peer ID: <code>{peerId || '...'}</code></p>
			<p>Status: {status}</p>
			<p>Model: <strong>{modelStatus}</strong> | Detections: <strong>{detectionCount}</strong></p>
			
			{/* Debug controls */}
			<div style={{ margin: '16px 0', padding: '16px', background: '#f5f5f5', borderRadius: '8px' }}>
				<h4>Debug Controls</h4>
				<button 
					onClick={() => preloadModel()} 
					disabled={modelStatus === 'loading'}
					style={{ 
						padding: '8px 16px', 
						margin: '8px', 
						background: modelStatus === 'ready' ? '#4CAF50' : '#2196F3',
						color: 'white',
						border: 'none',
						borderRadius: '4px',
						cursor: 'pointer'
					}}
				>
					{modelStatus === 'loading' ? 'Loading...' : 'Reload Model'}
				</button>
				<button 
					onClick={() => console.log('[viewer] Current state:', {
						modelStatus,
						ortSession: !!ortSessionRef.current,
						modelInputSize: modelInputSizeRef.current,
						detectionCount,
						inferenceTime
					})}
					style={{ 
						padding: '8px 16px', 
						margin: '8px', 
						background: '#FF9800',
						color: 'white',
						border: 'none',
						borderRadius: '4px',
						cursor: 'pointer'
					}}
				>
					Log State
				</button>
				<button 
					onClick={() => {
						console.log('[viewer] Testing WASM paths...');
						const paths = [
							'https://unpkg.com/onnxruntime-web@1.17.3/dist/ort-wasm.wasm',
							'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/ort-wasm.wasm',
							'https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.17.3/ort-wasm.wasm'
						];
						paths.forEach(async (url, i) => {
							try {
								const response = await fetch(url, { method: 'HEAD' });
								console.log(`[viewer] Path ${i + 1}: ${response.ok ? '✅' : '❌'} ${url}`);
							} catch (e) {
								const errorMessage = e && typeof e === 'object' && 'message' in e 
									? (e as any).message 
									: String(e);
								console.log(`[viewer] Path ${i + 1}: ❌ ${url} - ${errorMessage}`);
							}
						});
					}}
					style={{ 
						padding: '8px 16px', 
						margin: '8px', 
						background: '#9C27B0',
						color: 'white',
						border: 'none',
						borderRadius: '4px',
						cursor: 'pointer'
					}}
				>
					Test WASM Paths
				</button>
				<p style={{ fontSize: '12px', margin: '8px 0' }}>
					Model path: <code>/models/model.onnx</code><br/>
					Expected location: <code>apps/frontend/public/models/model.onnx</code><br/>
					WASM Status: {modelStatus === 'failed' ? '❌ CDN/WASM issue' : modelStatus === 'ready' ? '✅ Working' : '⏳ Loading...'}
				</p>
				<div style={{ marginTop: 8 }}>
					<button onClick={() => startMetrics()} style={{ padding: '6px 12px', marginRight: 8, borderRadius: 4, border: '1px solid #ccc', background: '#fff', cursor: 'pointer' }}>Start Metrics</button>
					<button onClick={() => stopMetricsAndDownload()} style={{ padding: '6px 12px', borderRadius: 4, border: '1px solid #ccc', background: '#fff', cursor: 'pointer' }}>Stop & Download metrics.json</button>
				</div>
			</div>
			
			<div ref={containerRef} style={{ position: 'relative', width: '100%', maxWidth: 720, aspectRatio: '16 / 9', background: '#000' }}>
				<video
					ref={videoRef}
					playsInline
					autoPlay
					controls
					style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', background: '#000' }}
				/>
				<canvas
					ref={overlayCanvasRef}
					style={{
						position: 'absolute',
						top: 0,
						left: 0,
						width: '100%',
						height: '100%',
						pointerEvents: 'none',
					}}
				/>
			</div>
			<div style={{ marginTop: 8 }}>
				<button onClick={toggleFullscreen} style={{ padding: '6px 12px', borderRadius: 4, border: '1px solid #ccc', background: '#fff', cursor: 'pointer' }}>
					{isFullscreen ? 'Exit Fullscreen' : 'Fullscreen Overlay'}
				</button>
			</div>
			<p style={{ fontSize: 12, opacity: 0.7 }}>
				Signaling: <code>{displaySigUrl || '...'}</code>
			</p>
		</div>
	);
}


