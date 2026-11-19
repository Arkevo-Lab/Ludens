@echo off
setlocal
set "APP_ROOT=%~dp0.."
if exist "%APP_ROOT%\node_modules\electron\dist\electron.exe" goto :run_local_electron
if exist "%APP_ROOT%\..\node_modules\electron\dist\electron.exe" goto :run_root_electron
call "%APP_ROOT%\node_modules\.bin\electron.cmd" "%APP_ROOT%\dist\electron\main.js" %*
exit /b %ERRORLEVEL%

:run_local_electron
"%APP_ROOT%\node_modules\electron\dist\electron.exe" "%APP_ROOT%\dist\electron\main.js" %*
exit /b %ERRORLEVEL%

:run_root_electron
"%APP_ROOT%\..\node_modules\electron\dist\electron.exe" "%APP_ROOT%\dist\electron\main.js" %*
exit /b %ERRORLEVEL%
