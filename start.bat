@echo off
echo Starting all services...

:: Terminal 1 - Signaling
start "Signaling" cmd /k ^
    "cd /d apps\signaling && npm install && npm start"

:: Terminal 2 - Frontend
start "Frontend" cmd /k ^
    "cd /d apps\frontend && npm install && npm run dev"

:: Terminal 3 - Inference
start "Inference" cmd /k ^
    "cd /d apps\inference && python -m venv .venv && .venv\Scripts\activate && pip install -r requirements.txt && python main.py"

echo All terminals launched.
exit
