@echo off
REM opencode-push-force - Force push (overwrite remote on conflict)
node "%USERPROFILE%\.config\opencode\scripts\opencode-sync-core.js" push --force %*
