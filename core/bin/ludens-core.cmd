@echo off
if defined LUDENS_BUN (
  "%LUDENS_BUN%" "%~dp0..\src\cli\main.ts" %*
) else (
  bun "%~dp0..\src\cli\main.ts" %*
)
exit /b %ERRORLEVEL%
