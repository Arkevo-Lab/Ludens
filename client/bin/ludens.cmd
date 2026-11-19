@echo off
setlocal
set "CLIENT_ROOT=%~dp0.."
where bun >nul 2>nul
if %ERRORLEVEL%==0 (
  bun "%CLIENT_ROOT%\cli\main.ts" %*
  exit /b %ERRORLEVEL%
)
if exist "%CLIENT_ROOT%\node_modules\.bin\tsx.cmd" (
  call "%CLIENT_ROOT%\node_modules\.bin\tsx.cmd" "%CLIENT_ROOT%\cli\main.ts" %*
  exit /b %ERRORLEVEL%
)
if exist "%CLIENT_ROOT%\..\node_modules\.bin\tsx.cmd" (
  call "%CLIENT_ROOT%\..\node_modules\.bin\tsx.cmd" "%CLIENT_ROOT%\cli\main.ts" %*
  exit /b %ERRORLEVEL%
)
node --import tsx "%CLIENT_ROOT%\cli\main.ts" %*
exit /b %ERRORLEVEL%
