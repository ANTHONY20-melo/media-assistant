@echo off
rem JARVIS Studio — Assistente de Mídia (desktop)
cd /d "%~dp0"
if not exist node_modules (
  echo [JARVIS] Instalando dependencias (primeira vez)...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :erro
)
echo [JARVIS] Abrindo JARVIS Studio...
call npm start
goto :fim
:erro
echo.
echo [JARVIS] Falha ao preparar o app. Verifique se o Node.js esta instalado.
pause
:fim
