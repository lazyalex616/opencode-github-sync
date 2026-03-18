@echo off
REM opencode-pull-force - Force pull (discard local changes)
node "%USERPROFILE%\.config\opencode\scripts\opencode-sync-core.js" pull --force %*
