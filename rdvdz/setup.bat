@echo off
REM ===========================================================================
REM  RDV DZ - installateur Windows
REM  Double-cliquez sur ce fichier, puis tapez 1 et Entree.
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

for /f "delims=" %%v in ('node -v 2^>nul') do set NODE_VERSION=%%v
echo   Node.js detecte : %NODE_VERSION%

where npm >nul 2>nul
if errorlevel 1 goto no_npm

REM --- Lancement de l'installateur -------------------------------------------
echo.
node "%~dp0setup.mjs" %*
set "EXIT_CODE=%ERRORLEVEL%"

if "%EXIT_CODE%"=="0" goto success
goto failed

:no_node
echo.
echo   [!] Node.js n'est pas installe sur cet ordinateur.
echo.
echo       1. La page de telechargement va s'ouvrir.
echo       2. Telechargez la version LTS (fichier .msi).
echo       3. Installez-la en laissant TOUTES les options par defaut.
echo       4. FERMEZ cette fenetre noire.
echo       5. Double-cliquez de nouveau sur setup.bat.
echo.
echo   Ouverture de https://nodejs.org/fr/download ...
start "" "https://nodejs.org/fr/download"
echo.
pause
exit /b 1

:no_npm
echo.
echo   [!] Node.js est present mais npm ne l'est pas.
echo.
echo       Reinstallez Node.js LTS en laissant les options par defaut :
echo         https://nodejs.org/fr/download
echo       Puis fermez cette fenetre et relancez setup.bat.
echo.
start "" "https://nodejs.org/fr/download"
echo.
pause
exit /b 1

:failed
echo.
echo   ---------------------------------------------------------------
echo    L'installation s'est arretee (code %EXIT_CODE%).
echo    Voici le detail, pour eviter de remonter dans la fenetre :
echo   ---------------------------------------------------------------
echo.
if exist "%~dp0setup-error.log" (
  type "%~dp0setup-error.log"
) else (
  echo    Aucun journal n'a pu etre ecrit.
  echo    Relancez en faisant un clic droit sur setup.bat
  echo    puis "Executer en tant qu'administrateur".
)
echo.
echo   ---------------------------------------------------------------
echo    Un fichier setup-error.log a ete cree dans le dossier rdvdz.
echo    Vous pouvez l'envoyer pour obtenir de l'aide.
echo   ---------------------------------------------------------------
echo.
pause
exit /b %EXIT_CODE%

:success
if exist "%~dp0setup-error.log" del "%~dp0setup-error.log" >nul 2>nul
echo.
echo   Installation terminee.
echo.
pause
exit /b 0
