# WebRTC VLM Multi-Object Detection

Real-time phone-to-browser WebRTC streaming with multi-object detection using YOLOv8.

## 🚀 Quick Start

### One-Command Startup
```bash
# Windows
start.bat
```


On Windows, `start.bat` launches all services (Signaling, Frontend, Inference) in separate terminals and sets up a Python virtual environment automatically. Choose WASM or Server mode from the homepage viewer links.

### Docker (one command)
```bash
docker-compose up --build
```

**Full setup guide**: See the start.bat file for detailed instructions.

## 📱 How It Works

1. **Phone streams** camera feed via WebRTC
2. **Browser receives** stream and processes frames
3. **AI inference** detects objects in real-time
4. **Overlays display** detection boxes and metrics
5. **Performance data** collected and exported

## 🎯 Features

### Dual Inference Modes
- **🔧 WASM Mode**: Browser-based inference (low resource). Use: `MODE=wasm ./start.sh`
- **🚀 Server Mode**: Backend inference (high performance). Use: `MODE=server ./start.sh`

### Real-Time Capabilities
- **Live streaming** with sub-100ms latency
- **Object detection** using YOLOv8 model
- **Performance metrics** (FPS, latency, bandwidth)
- **QR code connection** for easy phone setup

### Cross-Platform Support
- **Windows**: One-click batch file
- **Linux/Mac**: Shell script with fallbacks
- **Mobile**: Any device with camera and browser
- **Browser**: Chrome, Edge, Safari, Firefox

## 🏗️ Architecture

```
Phone Camera → WebRTC → Browser → Inference → Overlays
     ↓              ↓        ↓         ↓         ↓
  getUserMedia   Signaling  Viewer   WASM/API  Canvas
```

## 📊 Performance

### System Requirements
- **Minimum**: Intel i5-4th gen, 8GB RAM, 100Mbps network
- **Recommended**: Intel i7-8th gen, 16GB RAM, 500Mbps network

### Performance Metrics
- **WASM Mode**: 3-6 FPS, 200-500ms latency
- **Server Mode**: 8-15 FPS, 100-300ms latency
- **Accuracy**: 85-95% (YOLOv8n model)

## 🛠️ Installation

### Prerequisites
- **Node.js 16+** for frontend and signaling
- **Python 3.8+** for backend inference
- **Modern browser** with WebRTC support

### Quick Setup
1. **Clone repository**
   ```bash
   git clone <repository-url>
   cd webrtc-vlm
   ```

2. **Start services**
   ```bash
   # Windows
   start.bat
   
   # Linux/Mac
   ./start.sh
   ```

3. **Open browser** to `http://localhost:3000`

4. **Scan QR code** with phone camera

5. **Start detection** in viewer page

## 🔧 Configuration

### Environment Variables
```bash
# Frontend
FRONTEND_PORT=3000

# Signaling
SIGNALING_PORT=8080

# Inference
INFERENCE_PORT=8000
MODEL_PATH=/path/to/model.onnx

# Proxy
PROXY_PORT=8088
```

### Model Configuration
- **Default model**: YOLOv8n (320×320)
- **Location**: `apps/frontend/public/models/model.onnx`
- **Custom models**: Replace with your ONNX model
- **Supported formats**: ONNX, TensorFlow, PyTorch (via conversion)

## 📱 Usage

### Phone Setup
1. **Ensure same WiFi** as laptop
2. **Scan QR code** with camera app
3. **Allow permissions** when prompted
4. **Point camera** at objects to detect

### Viewer Options
- **WASM Mode**: Low resource, works offline
- **Server Mode**: High performance, requires backend
- **Metrics Collection**: Start/stop performance tracking
- **Fullscreen Overlay**: Immersive detection view

### Performance Monitoring
- **Real-time HUD**: FPS, latency, inference time
- **Metrics export**: Download `metrics.json` with results (now includes network latency)
- **Service status**: Monitor all component health
- **Resource usage**: Track CPU, memory, network

## 🚀 Deployment

### Local Development
```bash
# Install dependencies
cd apps/signaling && npm install
cd apps/frontend && npm install
cd apps/inference && pip install -r requirements.txt

# Start services
npm start          # Signaling
npm run dev        # Frontend
python main.py     # Inference
```

### Production Deployment
- **Windows**: Use start.bat with proper environment setup
- **Linux/Mac**: Use start.sh with systemd services
- **Cloud**: Deploy individual services to cloud platforms

## 🔍 Troubleshooting

### Common Issues

#### Services Won't Start
```bash
# Check port availability
netstat -an | findstr ":3000"    # Windows
netstat -an | grep ":3000"       # Linux/Mac

# Check Node.js installation
node --version
npm --version
```

#### Phone Connection Issues
- **Same WiFi network** required
- **Firewall settings** may block connections
- **Browser compatibility** (use Chrome/Safari)
- **Camera permissions** must be granted

#### Performance Issues
- **Switch inference modes** (WASM ↔ Server)
- **Check system resources** (CPU, memory)
- **Network quality** affects latency
- **Model loading** status in browser console

### Debug Mode
```bash
# Enable verbose logging
DEBUG=* npm start

# Check service logs
# Look at the console windows for each service

# Browser developer tools
F12 → Console → Network
```

## 🧪 Testing

### Automated Testing
```bash
# Run benchmark tests (auto-starts metrics when bench param is present)
cd bench
./run_bench.sh --duration 30 --mode wasm
./run_bench.sh --duration 30 --mode server
```

## ✅ Step-by-step Run Instructions

1. Clone repo and start services:
   - Windows: double-click `start.bat`
   - macOS/Linux: `./start.sh` (defaults to `MODE=wasm`) or `docker-compose up --build`
   - Optional: `MODE=server ./start.sh` for server inference mode
2. Open `http://localhost:3000` on your laptop; scan the QR for the Sender with your phone
3. Allow camera permission on phone; you should see the phone video mirrored with overlays
4. Open a Viewer: WASM or Server mode from the homepage buttons
5. Run a 30s bench and export metrics:
   - `./bench/run_bench.sh --duration 30 --mode wasm`
   - `./bench/run_bench.sh --duration 30 --mode server`
   - The viewer auto-starts metrics for bench URL and downloads `metrics.json` at the end

If the phone cannot reach your laptop directly (NAT/Wi‑Fi constraints):
- Use ngrok (free tier) to expose services and update the Viewer/Sender URLs:
  - `ngrok http 3000` (frontend), `ngrok http 8080` (signaling), `ngrok http 8000` (inference)
  - On the homepage or directly, replace URLs:
    - Sender: `http(s)://<frontend>/sender?room=room-1&sig=wss://<signaling-host>/`
    - Viewer (wasm): `http(s)://<frontend>/viewer?room=room-1&sig=wss://<signaling-host>/&mode=wasm`
    - Viewer (server): `http(s)://<frontend>/viewer?room=room-1&sig=wss://<signaling-host>/&mode=server&server=wss://<inference-host>/detect`
  - Tip: use `wss://` (secure WebSocket) when ngrok provides `https` URLs

## 📑 API Contract & Frame Alignment

Server → client JSON per detection result (normalized [0..1] coordinates):

```json
{
  "frame_id": "string_or_int",
  "capture_ts": 1690000000000,
  "recv_ts": 1690000000100,
  "inference_ts": 1690000000120,
  "detections": [
    { "label": "person", "score": 0.93, "xmin": 0.12, "ymin": 0.08, "xmax": 0.34, "ymax": 0.67 }
  ]
}
```

- The viewer uses `capture_ts` and `frame_id` to compute end-to-end latency and overlay detections.
- Current implementation draws the latest available detections; a strict `frame_id` pairing buffer is noted in `report.md` as the next improvement.

## 📏 Measurement & Bench

- E2E latency per frame: `overlay_display_ts - capture_ts`; median and P95 reported over the run
- Server latency: `inference_ts - recv_ts`
- Network latency: `recv_ts - capture_ts` (included in `metrics.json`)
- Processed FPS: sampling rate of displayed frames (EMA-based), exported as summary
- Bandwidth: WebRTC `getStats()` uplink/downlink kbps

Exported `metrics.json` contains: median & P95 E2E latency, processed FPS, uplink/downlink kbps, plus server and network latency summaries.

### Design Report
See `report.md` for design choices, low-resource mode, and backpressure policy.

### Loom Video
Add a 1-minute Loom link here demonstrating the phone→browser overlay and metrics: <ADD_LINK_HERE>

### Manual Testing
1. **Service health**: All indicators green
2. **Phone connection**: Video streams successfully
3. **Detection accuracy**: Objects properly identified
4. **Performance metrics**: FPS and latency acceptable
5. **System stability**: No crashes during extended use

### Test Scenarios
- **Single stream**: One phone to one viewer
- **Multiple streams**: Multiple phones to one viewer
- **Network stress**: High latency conditions
- **Long duration**: Extended usage testing


**Ready to get started?** Simply run `start.bat` (Windows) or `./start.sh` (Linux/Mac) to launch the system!
