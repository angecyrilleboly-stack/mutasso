@echo off
chcp 65001 >nul
title MUTASSO - Publication sur GitHub
echo ============================================================
echo   PUBLICATION DE MUTASSO SUR GITHUB
echo ============================================================
echo.
echo Étape 1 : créez le dépôt si ce n'est pas déjà fait :
echo   https://github.com/new?name=mutasso
echo   (nom : mutasso — NE cochez PAS "Add a README")
echo.
pause
echo.
echo Étape 2 : connexion GitHub (une fenêtre va s'ouvrir)...
git push -u origin main
echo.
if %errorlevel%==0 (
  echo ============================================================
  echo   SUCCÈS ! Code publié sur :
  echo   https://github.com/angecyrilleboly-stack/mutasso
  echo ============================================================
) else (
  echo Réessayez : la fenêtre de connexion GitHub n'a peut-être
  echo pas été validée. Relancez ce fichier.
)
echo.
pause
