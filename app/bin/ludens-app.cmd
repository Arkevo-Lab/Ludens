@echo off
setlocal
set "PET_ROOT=%~dp0.."
if exist "%PET_ROOT%\node_modules\electron\dist\electron.exe" (
  "%PET_ROOT%\node_modules\electron\dist\electron.exe" "%PET_ROOT%\dist\electron\main.js" %*
  exit /b %ERRORLEVEL%
)
call "%PET_ROOT%\node_modules\.bin\electron.cmd" "%PET_ROOT%\dist\electron\main.js" %*
