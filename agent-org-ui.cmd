@echo off
rem Start agent-org. Double-click to open the welcome page, or drag a team.yaml onto
rem this file (or run: agent-org-ui.cmd path\to\team.yaml) to open that team directly.
title agent-org
if "%~1"=="" (
  "C:\ProgramData\anaconda3\Scripts\conda.exe" run --no-capture-output -n formal --cwd "%~dp0." python -m agent_org.ui
) else (
  "C:\ProgramData\anaconda3\Scripts\conda.exe" run --no-capture-output -n formal --cwd "%~dp0." python -m agent_org.ui --team "%~f1"
)
if errorlevel 1 pause
