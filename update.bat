@echo off
REM ---------------------------------------------------------------------------
REM update.bat - pull the latest version of Trajectory Pool from the repo.
REM Double-click this file (or run it from a terminal) to update.
REM ---------------------------------------------------------------------------

REM Work from the folder this script lives in, whatever the current directory is.
cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Git is not installed or not on your PATH.
  echo Install Git from https://git-scm.com/download/win and try again.
  goto :end
)

if not exist ".git" (
  echo [ERROR] This folder is not a git clone, so there is nothing to update.
  echo Make sure update.bat sits in the root of your cloned repository.
  goto :end
)

echo Checking for updates...
git pull --ff-only
if errorlevel 1 (
  echo.
  echo [WARN] Update could not be applied automatically.
  echo This usually means you have local changes. Commit or stash them, then retry.
) else (
  echo.
  echo [OK] You are up to date.
)

:end
echo.
pause
