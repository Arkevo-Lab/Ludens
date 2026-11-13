@echo off
setlocal
set "APP_ROOT=%~dp0.."
if exist "%APP_ROOT%\node_modules\electron\dist\electron.exe" (
  "%APP_ROOT%\node_modules\electron\dist\electron.exe" "%APP_ROOT%\dist\electron\main.js" %*
  exit /b %ERRORLEVEL%
)
if exist "%APP_ROOT%\..\node_modules\electron\dist\electron.exe" (
  "%APP_ROOT%\..\node_modules\electron\dist\electron.exe" "%APP_ROOT%\dist\electron\main.js" %*
  exit /b %ERRORLEVEL%
)
call "%APP_ROOT%\node_modules\.bin\electron.cmd" "%APP_ROOT%\dist\electron\main.js" %*
exit /b %ERRORLEVEL%
