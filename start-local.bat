@echo off
rem Double-click to play +1 Jump Pogo locally: builds the client, starts the game server
rem on http://localhost:2567 and opens it in the browser. Close this window to stop the server.
cd /d "%~dp0"
if not exist node_modules call npm install
call npm run build
start "" http://localhost:2567
set PORT=2567
npm start
