@echo off
rem Start agent-org. Double-click to open the welcome page, or drag a team.yaml onto
rem this file (or run: agent-org-ui.cmd path\to\team.yaml) to open that team directly.
rem
rem Which Python runs it: AGENT_ORG_PYTHON if set, else the one named in python-path.txt
rem (one line, a full path to python.exe), else the environment install.cmd made in .venv.
title agent-org
setlocal
set "HERE=%~dp0"
set "PY="
if defined AGENT_ORG_PYTHON set "PY=%AGENT_ORG_PYTHON%"
if not defined PY if exist "%HERE%python-path.txt" set /p PY=<"%HERE%python-path.txt"
if not defined PY if exist "%HERE%.venv\Scripts\python.exe" set "PY=%HERE%.venv\Scripts\python.exe"
if not defined PY (
  echo agent-org is not set up on this computer yet: double-click install.cmd first.
  echo.
  pause
  exit /b 1
)
cd /d "%HERE%"
if "%~1"=="" (
  "%PY%" -m agent_org.ui
) else (
  "%PY%" -m agent_org.ui --team "%~f1"
)
if errorlevel 1 pause
