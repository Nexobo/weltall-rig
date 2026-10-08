@echo off
"%~dp0runtime\node.exe" "%~dp0cli.mjs" %*
exit /b %errorlevel%
