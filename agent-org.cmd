@echo off
rem Start agent-org. Double-click to open the welcome page, or drag a team.yaml onto this file (or run:
rem agent-org.cmd path\to\team.yaml) to open that team directly. If agent-org is running already, its
rem window comes back instead.
setlocal
set "HERE=%~dp0"
set "APP=%HERE%node_modules\electron\dist\electron.exe"
if not exist "%APP%" goto :setup
if not exist "%HERE%dist\electron\main.js" goto :setup
if "%~1"=="" (
  start "" "%APP%" "%HERE%."
) else (
  start "" "%APP%" "%HERE%." --team "%~f1"
)
exit /b 0

:setup
echo agent-org is not set up on this computer yet: double-click install.cmd first.
echo.
pause
exit /b 1
