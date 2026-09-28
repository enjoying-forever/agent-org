@echo off
rem Start the agent-org web UI for a team.
rem   agent-org-ui.cmd path\to\team.yaml     (or drag a team.yaml onto this file)
if "%~1"=="" (
  echo Usage: %~nx0 path\to\team.yaml   ^(or drag a team.yaml onto this file^)
  pause
  exit /b 1
)
"C:\ProgramData\anaconda3\Scripts\conda.exe" run --no-capture-output -n formal --cwd "%~dp0." python -m agent_org.ui --team "%~f1"
if errorlevel 1 pause
