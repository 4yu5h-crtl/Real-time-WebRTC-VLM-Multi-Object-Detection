# Design Report (1 page)

## Architecture
- Phone (Sender) → WebRTC (video track + DataChannel metadata) → Browser (Viewer)
- Viewer runs inference in 2 modes:
  - WASM mode: onnxruntime-web in browser, 320×240 sampling, YOLOv8n ONNX.
  - Server mode: FastAPI + onnxruntime CPU; viewer sends JPEG frames over WebSocket.
- Signaling: lightweight Node.js WebSocket server for SDP/ICE exchange.
- Overlay: Canvas draws normalized [0..1] boxes and labels; HUD shows frame_id, E2E latency, FPS, inference time.

## Low-resource mode
- Downscale to 320×240 canvas sampling at ~10 Hz.
- WASM single-threaded, SIMD disabled for compatibility.
- Backpressure: drop when busy
  - Sender skips metadata if DataChannel bufferedAmount>0.
  - Viewer sampling guarded by isSamplingRef.
  - Server mode: only one in-flight request; drops if busy.

## Frame alignment & JSON contract
- Sender metadata: {frame_id, capture_ts} over DataChannel.
- Server response: {frame_id, capture_ts, server_recv_ts, inference_ts, detections:[...normalized...]}.
- Viewer overlays using latest available metadata and detections; future work: strict pairing per frame_id.

## Backpressure policy
- “Latest wins” sampling; fixed-interval timer (~100 ms) processes only current frame.
- Drops queued frames under load to avoid increasing latency.

## Measurement
- E2E latency: overlay_display_ts - capture_ts (EMA displayed; raw samples exported).
- Server latency: inference_ts - server_recv_ts.
- Network latency: recv_ts - capture_ts now added.
- FPS: EMA of sampling interval; exported summary.
- Bandwidth: WebRTC getStats() deltas for uplink/downlink.

## Reproducibility
- One-command start via docker-compose up --build or ./start.sh.
- MODE switch: MODE=wasm ./start.sh (default) or MODE=server ./start.sh.

## CPU usage (guidance)
- Expected on i5/8GB (no GPU):
  - WASM: 25–60% browser tab CPU at 3–7 FPS, 200–500 ms E2E.
  - Server: 30–70% python CPU at 8–15 FPS, 100–300 ms E2E.
- **Actual Measured on User System (Windows):**
  - WASM: Peak CPU ~10%, Peak RAM ~69%
  - Server: Peak CPU ~15%, Peak RAM ~71%
- Actual numbers depend on model and lighting; measure with Task Manager/htop.

## Tradeoffs
- WASM: portable, lower bandwidth (no server roundtrip), but slower.
- Server: faster inference, but adds encode and network overhead.

## Next improvement (one-liner)
- Strict frame_id alignment buffer to draw detections on the exact matching frame.
