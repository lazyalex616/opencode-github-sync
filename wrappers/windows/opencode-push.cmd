@echo off
REM opencode-push - Push OpenCode config or sessions to GitHub
node "%USERPROFILE%\.config\opencode\scripts\opencode-sync-core.js" push %*
