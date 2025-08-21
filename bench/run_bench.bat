@echo off
setlocal ENABLEDELAYEDEXPANSION

REM Usage: run_bench.bat --duration 30 --mode wasm|server --server ws://localhost:8000/detect

set DURATION=30
set MODE=wasm
set SERVER=ws://localhost:8000/detect

REM Get local IP address for proper URL construction
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /C:"IPv4"') do (
    set "LOCAL_IP=%%a"
    set "LOCAL_IP=!LOCAL_IP: =!"
    goto :ip_found
)
:ip_found
if "!LOCAL_IP!"=="" set "LOCAL_IP=localhost"

:parse
if "%1"=="" goto args_done
if "%1"=="--duration" ( set DURATION=%2 & shift & shift & goto parse )
if "%1"=="--mode" ( set MODE=%2 & shift & shift & goto parse )
if "%1"=="--server" ( set SERVER=%2 & shift & shift & goto parse )
shift
goto parse

:args_done
echo Running bench for %DURATION%s in mode=%MODE%
echo Open the viewer URL below, then click Start Metrics and let it run for the duration.

REM Construct URL with proper escaping for Windows batch
if /I "%MODE%"=="server" (
  set "VIEWER_URL=http://!LOCAL_IP!:3000/viewer?room=room-1&sig=ws://!LOCAL_IP!:8080&mode=server&server=ws://!LOCAL_IP!:8000/detect&bench=%DURATION%"
) else (
  set "VIEWER_URL=http://!LOCAL_IP!:3000/viewer?room=room-1&sig=ws://!LOCAL_IP!:8080&mode=wasm&bench=%DURATION%"
)

echo %VIEWER_URL%
echo.
echo Opening browser...
start "" "%VIEWER_URL%"

echo Waiting %DURATION%s before reminding to stop metrics...
timeout /t %DURATION% >nul
echo.
echo Time up! Click "Stop & Download metrics.json" in the viewer.
echo.
echo The metrics.json file will contain:
echo   • Median and P95 end-to-end latency
echo   • Processed FPS
echo   • Uplink and downlink bandwidth
echo   • Server latency (server mode only)
echo.
echo Benchmark completed!

endlocal
exit /b 0

