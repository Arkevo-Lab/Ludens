@echo off
setlocal
set "CLIENT_ROOT=%~dp0.."
if defined LUDENS_BUN goto :run_custom_bun
where bun >nul 2>nul
if %ERRORLEVEL%==0 goto :run_bun
if exist "%CLIENT_ROOT%\node_modules\.bin\tsx.cmd" goto :run_local_tsx
if exist "%CLIENT_ROOT%\..\node_modules\.bin\tsx.cmd" goto :run_root_tsx
node --import tsx "%CLIENT_ROOT%\cli\main.ts" %*
exit /b %ERRORLEVEL%

:run_custom_bun
"%LUDENS_BUN%" "%CLIENT_ROOT%\cli\main.ts" %*
exit /b %ERRORLEVEL%

:run_bun
bun "%CLIENT_ROOT%\cli\main.ts" %*
exit /b %ERRORLEVEL%

:run_local_tsx
call "%CLIENT_ROOT%\node_modules\.bin\tsx.cmd" "%CLIENT_ROOT%\cli\main.ts" %*
exit /b %ERRORLEVEL%

:run_root_tsx
call "%CLIENT_ROOT%\..\node_modules\.bin\tsx.cmd" "%CLIENT_ROOT%\cli\main.ts" %*
exit /b %ERRORLEVEL%
