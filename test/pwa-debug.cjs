const { app, BrowserWindow } = require('electron');
const path = require('path'); const fs = require('fs'); const http = require('http');
const DOCS = path.join(__dirname, '..', 'docs');
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json' };
http.createServer((req,res)=>{ let p=decodeURIComponent(req.url.split('?')[0]); if(p.endsWith('/'))p+='index.html';
  const f=path.join(DOCS,p); if(!fs.existsSync(f)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':MIME[path.extname(f)]||'application/octet-stream'}); fs.createReadStream(f).pipe(res);
}).listen(0,'127.0.0.1',async function(){
  const port=this.address().port;
  await app.whenReady();
  const win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true}});
  await win.loadURL('http://127.0.0.1:'+port+'/');
  await new Promise(r=>setTimeout(r,3000));
  const out = await win.webContents.executeJavaScript(`(async () => {
    const { Filesystem, Directory, Encoding } = await import('./js/noop.js').catch(()=>({}));
    // use the bundled capacitor instance from the page
    const dbs = await indexedDB.databases();
    const before = window.ec.counts();
    window.ec.recordSession({session_id:'dbg',track_id:null,played_at:Date.now(),ms_listened:1000,user_ended:false});
    await new Promise(r=>setTimeout(r,2000));
    let dbFile = null, err = null;
    try {
      const cap = window.Capacitor;
      const fsplug = cap.Plugins.Filesystem;
      const r = await fsplug.readFile({ path: 'state/echocellar.db', directory: 'DATA', encoding: 'base64' });
      dbFile = r.data ? r.data.length : 0;
    } catch (e) { err = String(e && e.message || e); }
    let swReg = null, swErr = null;
    try { const r = await navigator.serviceWorker.register('sw.js'); swReg = r.scope; }
    catch (e) { swErr = String(e && e.message || e); }
    return { before, dbs: dbs.map(d=>d.name), dbFile, err, swReg, swErr };
  })()`);
  console.log('DEBUG', JSON.stringify(out, null, 1));
  app.exit(0);
});
