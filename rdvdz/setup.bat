@echo off
REM ===========================================================================
REM  RDV DZ - installateur Windows
REM  Double-cliquez sur ce fichier. Tout se fait ici : verification de Node,
REM  installation, configuration, base de donnees, verification, demarrage.
REM ===========================================================================
setlocal EnableExtensions

title RDV DZ - installation

cd /d "%~dp0"

echo.
echo   ============================================
echo    RDV DZ - installation
echo    Rendez-vous medicaux - plateforme + web
echo   ============================================
echo.

REM --- Node.js present ? -----------------------------------------------------
where node >nul 2>nul
if errorlevel 1 goto no_node

for /f "delims=" %%v in ('node -v') do set NODE_VERSION=%%v
echo   Node.js detecte : %NODE_VERSION%
echo.

REM --- Lancement de l'installateur ------------------------------------------
node "%~dp0setup.mjs" %*
set EXIT_CODE=%ERRORLEVEL%

if "%EXIT_CODE%"=="0" goto end
if "%EXIT_CODE%"=="1" goto failed
goto end

:no_node
echo   [!] Node.js n'est pas installe sur cet ordinateur.
echo.
echo       Telechargez la version LTS (installeur .msi, choix par defaut) :
echo         https://nodejs.org/fr/download
echo.
echo       Apres l'installation, FERMEZ cette fenetre puis
echo       double-cliquez de nouveau sur setup.bat.
echo.
echo   Ouverture de la page de telechargement...
start "" "https://nodejs.org/fr/download"
echo.
pause
exit /b 1

:failed
echo.
echo   L'installation s'est arretee sur une erreur (code %EXIT_CODE%).
echo   Lisez le message ci-dessus : il indique quoi faire.
echo.
pause
exit /b %EXIT_CODE%

:end
REM Si le serveur a ete lance, on arrive ici apres Ctrl+C : on garde la fenetre
REM ouverte pour que l'utilisateur puisse lire le journal.
echo.
pause
exit /b 0
