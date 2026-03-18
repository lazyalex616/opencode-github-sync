@echo off
REM opencode-pull - Pull OpenCode config or sessions from GitHub
node "%USERPROFILE%\.config\opencode\scripts\opencode-sync-core.js" pull %*
