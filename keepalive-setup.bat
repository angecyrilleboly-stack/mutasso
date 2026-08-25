@echo off
schtasks /Create /TN "MutassoKeepAlive" /TR "C:\Windows\System32\curl.exe -s https://mutasso.onrender.com/api/health" /SC MINUTE /MO 10 /F
echo.
schtasks /Query /TN "MutassoKeepAlive"
pause
