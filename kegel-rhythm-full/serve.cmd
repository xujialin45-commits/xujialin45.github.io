@echo off
rem 本地预览：启动静态服务器后用浏览器打开 http://127.0.0.1:8777/
cd /d "%~dp0src"
where python >nul 2>nul
if %errorlevel%==0 (
  echo 提肛节拍本地预览: http://127.0.0.1:8777/
  start "" http://127.0.0.1:8777/
  python -m http.server 8777 --bind 127.0.0.1
  goto :eof
)
where node >nul 2>nul
if %errorlevel%==0 (
  echo 未找到 Python，改用 Node 内置服务器...
  start "" http://127.0.0.1:8777/
  node -e "const h=require('http'),f=require('fs'),p=require('path');const t={'.html':'text/html;charset=utf-8','.css':'text/css;charset=utf-8','.js':'text/javascript;charset=utf-8','.png':'image/png','.webmanifest':'application/manifest+json','.json':'application/json'};h.createServer((q,s)=>{let u=decodeURIComponent(q.url.split('?')[0]);if(u==='/')u='/index.html';const fp=p.join(process.cwd(),u);f.readFile(fp,(e,d)=>{if(e){s.writeHead(404);return s.end('not found')}s.writeHead(200,{'content-type':t[p.extname(fp)]||'application/octet-stream'});s.end(d)})}).listen(8777,'127.0.0.1',()=>console.log('http://127.0.0.1:8777/'))"
  goto :eof
)
echo 没有找到 Python 或 Node，请安装其一，或用任意静态服务器托管 src 目录。
pause
