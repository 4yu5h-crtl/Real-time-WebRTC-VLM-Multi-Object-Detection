#!/bin/bash

echo "============================================="
echo "  WebRTC VLM - One Click Start"
echo "============================================="

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo
echo "Checking system requirements..."

# Enhanced Node.js detection
NODE_FOUND=0
NPM_FOUND=0

# Check if node is in PATH
if command -v node &> /dev/null; then
    NODE_FOUND=1
    echo "Checking Node.js..."
    node --version
fi

# If not in PATH, try common installation locations
if [ $NODE_FOUND -eq 0 ]; then
    echo "Node.js not in PATH, checking common locations..."
    
    # Check common Node.js installation paths
    NODE_PATHS=(
        "/usr/bin/node"
        "/usr/local/bin/node"
        "/opt/node/bin/node"
        "/snap/bin/node"
        "$HOME/.nvm/versions/node/*/bin/node"
        "$HOME/.node/bin/node"
        "/Applications/Node.js.app/Contents/MacOS/node"
    )
    
    for node_path in "${NODE_PATHS[@]}"; do
        if [ -f "$node_path" ] || ls $node_path &> /dev/null; then
            export PATH="$(dirname "$node_path"):$PATH"
            NODE_FOUND=1
            echo "Found Node.js in: $(dirname "$node_path")"
            node --version
            break
        fi
    done
fi

# Check npm
if [ $NODE_FOUND -eq 1 ]; then
    if command -v npm &> /dev/null; then
        NPM_FOUND=1
        echo "Checking npm..."
        npm --version
    fi
fi

# Final check
if [ $NODE_FOUND -eq 0 ]; then
    echo
    echo "❌ ERROR: Node.js not found!"
    echo "Please install Node.js 16+ from https://nodejs.org/"
    echo
    echo "If Node.js is already installed, try:"
    echo "1. Restart your terminal after installation"
    echo "2. Run this script as root/sudo if needed"
    echo "3. Check if Node.js is in your system PATH"
    echo "4. Use a Node.js version manager like nvm"
    echo
    read -p "Press Enter to exit"
    exit 1
fi

if [ $NPM_FOUND -eq 0 ]; then
    echo
    echo "❌ ERROR: npm not found!"
    echo "Please ensure Node.js installation added npm to PATH."
    echo
    read -p "Press Enter to exit"
    exit 1
fi

# Check Python with better detection
echo "Checking Python..."
PYTHON_FOUND=0

# Try python3 first, then python
if command -v python3 &> /dev/null; then
    PYTHON_CMD="python3"
    PYTHON_FOUND=1
    echo "✅ Python found:"
    python3 --version
elif command -v python &> /dev/null; then
    # Check if it's Python 3
    if python --version 2>&1 | grep -q "Python 3"; then
        PYTHON_CMD="python"
        PYTHON_FOUND=1
        echo "✅ Python found:"
        python --version
    else
        echo "⚠️  WARNING: Python 2 found, but Python 3 is required!"
        echo "Server-mode inference will not work."
        echo "Install Python 3.8+ from https://python.org/ for full functionality."
        PYTHON_FOUND=0
    fi
else
    echo "⚠️  WARNING: Python not found!"
    echo "Server-mode inference will not work."
    echo "Install Python 3.8+ from https://python.org/ for full functionality."
    PYTHON_FOUND=0
fi

echo
echo "🧹 Stopping any existing Node processes..."
pkill -f "node" 2>/dev/null || true

echo
echo "📦 Installing dependencies..."

# Install signaling dependencies
if [ ! -d "apps/signaling/node_modules" ]; then
    echo "Installing signaling dependencies..."
    cd apps/signaling
    npm install --no-audit --no-fund
    if [ $? -ne 0 ]; then
        echo "❌ ERROR: Failed to install signaling dependencies"
        read -p "Press Enter to exit"
        exit 1
    fi
    cd "$SCRIPT_DIR"
fi

# Install frontend dependencies
if [ ! -d "apps/frontend/node_modules" ]; then
    echo "Installing frontend dependencies..."
    cd apps/frontend
    npm install --no-audit --no-fund
    if [ $? -ne 0 ]; then
        echo "❌ ERROR: Failed to install frontend dependencies"
        read -p "Press Enter to exit"
        exit 1
    fi
    cd "$SCRIPT_DIR"
fi

echo
echo "🚀 Starting services..."

# Enhanced terminal detection and startup
# Try multiple terminal emulators for better cross-platform support
start_terminal() {
    local title="$1"
    local command="$2"
    
    # Try gnome-terminal (Ubuntu/Debian)
    if command -v gnome-terminal &> /dev/null; then
        gnome-terminal --title="$title" -- bash -c "$command; exec bash" 2>/dev/null && return 0
    fi
    
    # Try xterm (X11 systems)
    if command -v xterm &> /dev/null; then
        xterm -title "$title" -e "bash -c '$command; exec bash'" 2>/dev/null && return 0
    fi
    
    # Try konsole (KDE)
    if command -v konsole &> /dev/null; then
        konsole --title "$title" -e bash -c "$command; exec bash" 2>/dev/null && return 0
    fi
    
    # Try macOS Terminal
    if command -v osascript &> /dev/null; then
        osascript -e "tell application \"Terminal\" to do script \"cd '$SCRIPT_DIR' && $command\"" 2>/dev/null && return 0
    fi
    
    # Try alacritty (modern terminal)
    if command -v alacritty &> /dev/null; then
        alacritty --title "$title" -e bash -c "$command" 2>/dev/null && return 0
    fi
    
    # Try kitty (modern terminal)
    if command -v kitty &> /dev/null; then
        kitty --title "$title" bash -c "$command" 2>/dev/null && return 0
    fi
    
    # Fallback: just echo the command
    echo "⚠️  Please open a new terminal and run: $command"
    return 1
}

# Start signaling server
echo "Starting signaling server (WebSocket :8080)..."
start_terminal "Signaling Server" "cd '$SCRIPT_DIR/apps/signaling' && echo 'Starting signaling server...' && npm start"

# Start frontend server
echo "Starting frontend (Next.js :3000)..."
start_terminal "Frontend Server" "cd '$SCRIPT_DIR/apps/frontend' && echo 'Starting frontend...' && npm run dev"

# Start inference server if Python is available
if [ $PYTHON_FOUND -eq 1 ]; then
    echo "Starting inference server (FastAPI :8000)..."
    
    if [ ! -d "apps/inference/.venv" ]; then
        echo "Creating Python virtual environment..."
        cd apps/inference
        $PYTHON_CMD -m venv .venv
        cd "$SCRIPT_DIR"
    fi
    
    if [ -f "apps/inference/requirements.txt" ]; then
        start_terminal "Inference Server" "cd '$SCRIPT_DIR/apps/inference' && echo 'Activating virtual environment...' && source .venv/bin/activate && echo 'Installing Python dependencies...' && pip install -r requirements.txt && echo 'Starting FastAPI server...' && python main.py"
    else
        echo "⚠️  WARNING: requirements.txt not found. Inference server will not start."
    fi
else
    echo "⚠️  Skipping inference server (Python not available)"
fi

echo
echo "⏳ Waiting for services to start..."
sleep 8

echo
echo "============================================="
echo "  SERVICES STARTED SUCCESSFULLY!"
echo "============================================="
echo
echo "Service Endpoints:"
echo " - Frontend:   http://localhost:3000"
echo " - Signaling:  ws://localhost:8080"
echo " - Inference:  http://localhost:8000"
echo
echo "Phone Connection URLs:"
echo " - Sender:     http://localhost:3000/sender?room=room-1&sig=ws://localhost:8080"
echo " - Viewer WASM: http://localhost:3000/viewer?room=room-1&sig=ws://localhost:8080&mode=wasm"
echo " - Viewer Server: http://localhost:3000/viewer?room=room-1&sig=ws://localhost:8080&mode=server&server=ws://localhost:8000/detect"
echo
echo "Terminal Windows Opened:"
echo "  - Signaling Server (WebSocket server)"
echo "  - Frontend Server (Next.js app)"
echo "  - Inference Server (Python FastAPI - if available)"
echo
echo "To stop all services, close the terminal windows."
echo
echo "Opening frontend in browser..."

# MODE switch for convenience: MODE=wasm (default) or MODE=server
MODE=${MODE:-wasm}
VIEW_URL="http://localhost:3000"
if [ "$MODE" = "wasm" ]; then
    VIEW_URL="http://localhost:3000/viewer?room=room-1&sig=ws://localhost:8080&mode=wasm"
elif [ "$MODE" = "server" ]; then
    VIEW_URL="http://localhost:3000/viewer?room=room-1&sig=ws://localhost:8080&mode=server&server=ws://localhost:8000/detect"
fi

# Enhanced browser opening for different platforms
if command -v xdg-open &> /dev/null; then
    # Linux
    xdg-open "$VIEW_URL"
elif command -v open &> /dev/null; then
    # macOS
    open "$VIEW_URL"
elif command -v sensible-browser &> /dev/null; then
    # Debian/Ubuntu
    sensible-browser "$VIEW_URL"
elif command -v w3m &> /dev/null; then
    # Text-based browser
    echo "Opening in text browser..."
    w3m "$VIEW_URL"
else
    echo "Please open $VIEW_URL in your browser"
fi

echo
echo "🌐 Browser opened! Scan the QR code with your phone to connect."
echo
echo "TROUBLESHOOTING:"
echo "- If phone can't connect: ensure same WiFi network"
echo "- If services fail: check terminal windows for error messages"
echo "- If ports are busy: close other applications using ports 3000, 8080, 8000"
echo "- If terminals don't open: run the commands manually in separate terminals"
echo
echo "Manual commands if terminals don't open:"
echo "  Terminal 1: cd '$SCRIPT_DIR/apps/signaling' && npm start"
echo "  Terminal 2: cd '$SCRIPT_DIR/apps/frontend' && npm run dev"
if [ $PYTHON_FOUND -eq 1 ]; then
    echo "  Terminal 3: cd '$SCRIPT_DIR/apps/inference' && source .venv/bin/activate && pip install -r requirements.txt && python main.py"
fi
echo
read -p "Press Enter to continue"
