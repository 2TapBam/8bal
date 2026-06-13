@echo off
setlocal enabledelayedexpansion
REM ---------------------------------------------------------------------------
REM update.bat - get the latest version of Trajectory Pool.
REM
REM If this folder is a git clone it just runs "git pull". If you downloaded the
REM files as a ZIP (no .git folder), it can connect this folder to the repo and
REM pull the latest version for you.
REM
REM If the repo URL below is ever wrong, edit just this one line:
REM ---------------------------------------------------------------------------
set "REPO_URL=https://github.com/2TapBam/8bal.git"
set "BRANCH=claude/bold-fermi-ezf89b"

REM Work from the folder this script lives in.
cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Git is not installed or not on your PATH.
  echo Install Git from https://git-scm.com/download/win and run this again.
  goto end
)

if exist ".git\" goto update

REM --- not a clone yet: offer to connect this folder to the repo ---
echo This folder is not a git clone, so it cannot pull updates yet.
echo.
echo update.bat can connect it to:
echo     %REPO_URL%
echo     branch: %BRANCH%
echo.
echo WARNING: this replaces the project files in this folder with the latest
echo version from the repo. Any local edits to those files will be lost.
echo.
set /p ok=Connect and update now? [Y/N]
if /i not "%ok%"=="Y" goto end

git init -q
git remote remove origin >nul 2>nul
git remote add origin "%REPO_URL%"
git fetch --depth=1 origin "%BRANCH%"
if errorlevel 1 (
  echo.
  echo [ERROR] Could not fetch from the repo. Check the REPO_URL at the top of
  echo this file and your internet connection. If the repo is private you must
  echo be signed in to GitHub when the credential prompt appears.
  goto end
)
git checkout -f -B "%BRANCH%" FETCH_HEAD
if errorlevel 1 (
  echo [ERROR] Could not check out the files.
  goto end
)
git branch --set-upstream-to=origin/%BRANCH% >nul 2>nul
echo.
echo [OK] Connected and updated to the latest version.
goto end

:update
echo Checking for updates...
git pull --ff-only origin "%BRANCH%"
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
