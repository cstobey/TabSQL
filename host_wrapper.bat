@echo off
:: host_wrapper.bat - launched by Chrome as the native messaging host
:: Adjust PYTHON and DAEMON_DIR to match your install paths.

set PYTHON=C:\Python312\python.exe
set DAEMON_DIR=C:\taboutliner\daemon

cd /d %DAEMON_DIR%
%PYTHON% host.py
