@echo off
REM opencode-pull-force - Force pull (discard local changes)
node "%USERPROFILE%\.config\opencode\scripts\opencode-launcher.js" pull --force %*
