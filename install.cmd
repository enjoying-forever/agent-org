@echo off
rem Set up agent-org on this computer: its packages (in node_modules here, Electron among them) and its
rem compiled code (dist). Run it once, and again after updating agent-org; it is safe to repeat.
title agent-org setup
setlocal
set "HERE=%~dp0"
cd /d "%HERE%"

echo.
echo  agent-org setup
echo  ===============
echo.

rem 1. Node.js 22.13 or newer: it installs agent-org (the app itself then runs on its own Electron).
set "NODE_OK="
for /f "delims=" %%V in ('node -e "const [a,b]=process.versions.node.split('.').map(Number);console.log(a>22||(a===22&&b>=13)?'yes':'old')" 2^>nul') do set "NODE_OK=%%V"
if not "%NODE_OK%"=="yes" (
  if "%NODE_OK%"=="old" (echo  agent-org needs Node.js 22.13 or newer; this computer has an older one.) else (echo  agent-org needs Node.js 22.13 or newer, and none was found.)
  echo  Install it from https://nodejs.org ^(the LTS version^), or in a terminal:
  echo      winget install OpenJS.NodeJS.LTS
  echo  Then open a new window and run install.cmd again.
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%V in ('node -v') do echo  Node.js: %%V

rem 2. The packages, and the compiled code. A proxy in HTTPS_PROXY is used for the downloads.
set "NODE_USE_ENV_PROXY=1"
echo  Installing the packages ^(Electron, node-pty, yaml, smol-toml^) ...
call npm install --no-fund --no-audit --loglevel=error || goto :failed
echo  Building ...
call npm run --silent build || goto :failed

rem 3. PowerShell 7: every agent starts through it.
where pwsh >nul 2>nul
if errorlevel 1 (
  echo.
  echo  PowerShell 7 is not installed, and agents start through it.
  where winget >nul 2>nul
  if errorlevel 1 (
    echo  Install it from https://aka.ms/powershell, then start agent-org.
  ) else (
    choice /c YN /m " Install it now with winget"
    if not errorlevel 2 winget install --id Microsoft.PowerShell --source winget
  )
)

rem 4. What else is needed: the agent programs, signed in.
echo.
echo  Setup check:
node "%HERE%dist\doctor.js"
echo.
echo  Done. Start agent-org by double-clicking agent-org.cmd.
echo  Each agent program you use must be signed in once in a normal terminal: claude, codex, grok, agy.
echo.
pause
exit /b 0

:failed
echo.
echo  Setup did not finish ^(see the message above^). Check your internet connection ^(behind a proxy: set
echo  HTTPS_PROXY first^) and run install.cmd again.
echo.
pause
exit /b 1
