@echo off
rem Set up agent-org on this computer: a private Python environment in this folder (.venv) with
rem the few packages it needs. Run it once (again after updating agent-org; it is safe to repeat).
title agent-org setup
setlocal
set "HERE=%~dp0"
cd /d "%HERE%"

echo.
echo  agent-org setup
echo  ===============
echo.

rem 1. A Python 3.11 or newer: the Python launcher (py) first, then python on PATH.
set "PY="
for %%V in (3.13 3.12 3.11 3) do (
  if not defined PY (
    py -%%V -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul && set "PY=py -%%V"
  )
)
if not defined PY (
  python -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo  agent-org needs Python 3.11 or newer, and none was found.
  echo  Install it from https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^),
  echo  or in a terminal: winget install Python.Python.3.12
  echo  Then run install.cmd again.
  echo.
  pause
  exit /b 1
)
echo  Python: %PY%

rem 2. The private environment, and the packages in it.
if not exist "%HERE%.venv\Scripts\python.exe" (
  echo  Creating the environment in .venv ...
  %PY% -m venv "%HERE%.venv" || goto :failed
)
echo  Installing the packages ^(PyYAML, pywinpty, pywebview, tzdata^) ...
"%HERE%.venv\Scripts\python.exe" -m pip install --disable-pip-version-check --quiet -r "%HERE%requirements.txt" || goto :failed

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
"%HERE%.venv\Scripts\python.exe" -m agent_org.doctor
echo.
echo  Done. Start agent-org by double-clicking agent-org-ui.cmd.
echo  Each agent program you use must be signed in once in a normal terminal: claude, codex, grok, agy.
echo.
pause
exit /b 0

:failed
echo.
echo  Setup did not finish ^(see the message above^). Check your internet connection and run install.cmd again.
echo.
pause
exit /b 1
