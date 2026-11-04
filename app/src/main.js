// Пингвинопитек — главный процесс
'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const https = require('https');
const { spawn, execFile } = require('child_process');
const { v2: webdav } = require('webdav-server');

const IS_WIN = process.platform === 'win32';
const REPO = 'ivanivorontsov-sudo/pingvinopitek';
const DATA = process.env.PINGVINOPITEK_DATA ||
  path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'Pingvinopitek');
const VM_DIR = path.join(DATA, 'vm');
const BASE = path.join(VM_DIR, 'base.qcow2');
const DISK = path.join(VM_DIR, 'disk.qcow2');
const CFG = path.join(DATA, 'settings.json');
fs.mkdirSync(VM_DIR, { recursive: true });

const defaults = {
  ramMB: 4096, cpus: 4, accel: 'auto', shareDir: path.join(require('os').homedir(), 'Pingvinopitek'),
  imageTag: 'image-v1', token: ''
};
function loadCfg() { try { return { ...defaults, ...JSON.parse(fs.readFileSync(CFG, 'utf8')) }; } catch { return { ...defaults }; } }
function saveCfg(c) { fs.writeFileSync(CFG, JSON.stringify(c, null, 2)); }
let cfg = loadCfg();
function getToken() {
  if (!cfg.token) return '';
  try { return safeStorage.decryptString(Buffer.from(cfg.token, 'base64')); } catch { return ''; }
}

function qemuDir() {
  if (process.env.PINGVINOPITEK_QEMU) return process.env.PINGVINOPITEK_QEMU;
  const p = path.join(process.resourcesPath || '', 'qemu');
  return fs.existsSync(p) ? p : '';
}
function qemuBin(name) {
  const d = qemuDir();
  const exe = IS_WIN ? name + '.exe' : name;
  return d ? path.join(d, exe) : exe;
}

let win; let qemu = null; let ports = null; let davServer = null; let state = 'stopped'; let accelUsed = '';
function send(ch, ...a) { if (win && !win.isDestroyed()) win.webContents.send(ch, ...a); }
function log(s) { send('log', String(s)); try { fs.appendFileSync(path.join(DATA, 'pingvinopitek.log'), new Date().toISOString() + ' ' + s + '\n'); } catch {} }
function setState(s) { state = s; send('state', s, accelUsed); }

function freePort() {
  return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
}

// ---------- WebDAV-сервер общей папки ----------
async function startDav() {
  if (davServer) return davServer.__port;
  fs.mkdirSync(cfg.shareDir, { recursive: true });
  const port = await freePort();
  const srv = new webdav.WebDAVServer({ port, hostname: '127.0.0.1' });
  await new Promise((res, rej) => srv.setFileSystem('/', new webdav.PhysicalFileSystem(cfg.shareDir), ok => ok ? res() : rej(new Error('webdav'))));
  await new Promise(res => srv.start(() => res()));
  srv.__port = port; davServer = srv;
  log('Общая папка: ' + cfg.shareDir + ' (WebDAV 127.0.0.1:' + port + ')');
  return port;
}

// ---------- Образ ----------
function imageReady() { return fs.existsSync(BASE); }
function ensureOverlay() {
  return new Promise((res, rej) => {
    if (fs.existsSync(DISK)) return res();
    execFile(qemuBin('qemu-img'), ['create', '-f', 'qcow2', '-b', BASE, '-F', 'qcow2', DISK], (e, o, er) => e ? rej(new Error(er || e.message)) : res());
  });
}
async function importParts(files) {
  files = files.slice().sort();
  // если выбран один кусок .partNN — найти соседние
  if (files.length === 1 && /\.part\d+$/i.test(files[0])) {
    const dir = path.dirname(files[0]); const stem = path.basename(files[0]).replace(/\.part\d+$/i, '');
    files = fs.readdirSync(dir).filter(f => f.startsWith(stem + '.part')).sort().map(f => path.join(dir, f));
  }
  const tmp = BASE + '.tmp';
  const out = fs.createWriteStream(tmp);
  let done = 0; const total = files.reduce((a, f) => a + fs.statSync(f).size, 0);
  for (const f of files) {
    await new Promise((res, rej) => {
      const r = fs.createReadStream(f);
      r.on('data', b => { done += b.length; send('progress', done / total, 'Импорт образа'); });
      r.on('error', rej); r.on('end', res); r.pipe(out, { end: false });
    });
  }
  await new Promise(r => out.end(r));
  if (fs.existsSync(DISK)) fs.unlinkSync(DISK);
  fs.renameSync(tmp, BASE);
  log('Образ импортирован: ' + files.length + ' файл(ов)');
}

function ghRequest(url, accept, token) {
  return new Promise((res, rej) => {
    const h = { 'User-Agent': 'Pingvinopitek', Accept: accept };
    if (token) h.Authorization = 'Bearer ' + token;
    const go = (u, hops) => https.get(u, { headers: hops ? { 'User-Agent': 'Pingvinopitek' } : h }, r => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode)) { r.resume(); return go(r.headers.location, (hops || 0) + 1); }
      if (r.statusCode !== 200) { r.resume(); return rej(new Error('HTTP ' + r.statusCode + ' ' + u)); }
      res(r);
    }).on('error', rej);
    go(url, 0);
  });
}
async function downloadImage() {
  const token = getToken();
  const rel = await ghRequest(`https://api.github.com/repos/${REPO}/releases/tags/${cfg.imageTag}`, 'application/vnd.github+json', token);
  let body = ''; for await (const c of rel) body += c;
  const assets = JSON.parse(body).assets.filter(a => /\.qcow2(\.part\d+)?$/.test(a.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (!assets.length) throw new Error('В релизе нет частей образа');
  const total = assets.reduce((a, x) => a + x.size, 0); let done = 0;
  const parts = [];
  for (const a of assets) {
    const dst = path.join(VM_DIR, a.name);
    if (!(fs.existsSync(dst) && fs.statSync(dst).size === a.size)) {
      const r = await ghRequest(a.url, 'application/octet-stream', token);
      await new Promise((res, rej) => {
        const w = fs.createWriteStream(dst);
        r.on('data', b => { done += b.length; send('progress', done / total, 'Загрузка образа'); });
        r.pipe(w); w.on('finish', res); r.on('error', rej); w.on('error', rej);
      });
    } else done += a.size;
    parts.push(dst);
  }
  await importParts(parts);
  for (const p of parts) try { fs.unlinkSync(p); } catch {}
}

// ---------- QEMU ----------
function qemuArgs(accel) {
  const a = [
    '-name', 'Пингвинопитек', '-machine', 'q35', '-m', String(cfg.ramMB), '-smp', String(cfg.cpus),
    '-drive', `file=${DISK},if=virtio,discard=unmap,cache=writeback`,
    '-device', 'virtio-vga',
    '-device', 'qemu-xhci', '-device', 'usb-tablet', '-device', 'usb-kbd',
    '-device', 'virtio-serial-pci',
    '-chardev', 'qemu-vdagent,id=vda,name=vdagent,clipboard=on,mouse=off',
    '-device', 'virtserialport,chardev=vda,name=com.redhat.spice.0',
    '-chardev', `socket,id=qga,host=127.0.0.1,port=${ports.qga},server=on,wait=off`,
    '-device', 'virtserialport,chardev=qga,name=org.qemu.guest_agent.0',
    '-qmp', `tcp:127.0.0.1:${ports.qmp},server=on,wait=off`,
    '-nic', `user,model=virtio-net-pci,guestfwd=tcp:10.0.2.100:80-tcp:127.0.0.1:${ports.dav}`,
    '-vnc', `127.0.0.1:${ports.vnc - 5900},websocket=${ports.ws}`,
    '-device', 'virtio-rng-pci', '-display', 'none'
  ];
  if (IS_WIN) a.push('-audiodev', 'dsound,id=snd'); else a.push('-audiodev', 'none,id=snd');
  a.push('-device', 'intel-hda', '-device', 'hda-duplex,audiodev=snd');
  if (accel === 'whpx') a.push('-accel', 'whpx,kernel-irqchip=off', '-cpu', 'qemu64,+ssse3,+sse4.1,+sse4.2,+popcnt');
  else if (accel === 'kvm') a.push('-accel', 'kvm', '-cpu', 'host');
  else a.push('-accel', 'tcg,thread=multi,tb-size=512', '-cpu', 'max');
  return a;
}
function accelOrder() {
  if (cfg.accel !== 'auto') return [cfg.accel];
  return IS_WIN ? ['whpx', 'tcg'] : (fs.existsSync('/dev/kvm') ? ['kvm', 'tcg'] : ['tcg']);
}
function startQemuWith(accel) {
  return new Promise(res => {
    const args = qemuArgs(accel);
    log('Запуск QEMU (' + accel + ')');
    const p = spawn(qemuBin('qemu-system-x86_64'), args, { cwd: qemuDir() || undefined, windowsHide: true });
    let err = ''; let settled = false;
    p.stderr.on('data', d => { err += d; log('[qemu] ' + String(d).trim()); });
    p.on('error', e => { if (!settled) { settled = true; res({ ok: false, err: e.message }); } });
    p.on('exit', code => {
      if (!settled) { settled = true; return res({ ok: false, err: err || ('код ' + code) }); }
      if (qemu === p) { qemu = null; accelUsed = ''; setState('stopped'); log('Linux выключен (код ' + code + ')'); }
    });
    setTimeout(() => { if (!settled) { settled = true; res({ ok: true, proc: p }); } }, 4000);
  });
}
async function startVM() {
  if (qemu) return { ok: true };
  if (!imageReady()) return { ok: false, err: 'Образ Linux ещё не установлен' };
  setState('starting');
  try { await ensureOverlay(); } catch (e) { setState('stopped'); return { ok: false, err: e.message }; }
  ports = { qga: await freePort(), qmp: await freePort(), ws: await freePort(), vnc: 0, dav: await startDav() };
  // VNC-порт должен быть >= 5900
  for (let p = 5910; p < 5990; p++) { if (await new Promise(r => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(p, '127.0.0.1', () => s.close(() => r(true))); })) { ports.vnc = p; break; } }
  let last = '';
  for (const acc of accelOrder()) {
    const r = await startQemuWith(acc);
    if (r.ok) { qemu = r.proc; accelUsed = acc; setState('running'); return { ok: true, ws: ports.ws, accel: acc }; }
    last = r.err; log('Ускоритель ' + acc + ' не подошёл: ' + r.err);
  }
  setState('stopped');
  return { ok: false, err: last };
}

// ---------- QMP / гостевой агент ----------
function jsonRpc(port, cmds, timeout = 15000) {
  return new Promise((res, rej) => {
    const s = net.connect(port, '127.0.0.1'); let buf = ''; const out = []; let i = 0; let cap = false;
    const t = setTimeout(() => { s.destroy(); rej(new Error('Нет ответа от гостевой системы')); }, timeout);
    const next = () => { if (i < cmds.length) s.write(JSON.stringify(cmds[i++]) + '\n'); else { clearTimeout(t); s.end(); res(out); } };
    s.on('data', d => {
      buf += d; let k;
      while ((k = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, k).trim(); buf = buf.slice(k + 1); if (!line) continue;
        const m = JSON.parse(line);
        if (m.QMP) { cap = true; s.write('{"execute":"qmp_capabilities"}\n'); continue; }
        if (m.event) continue;
        if (cap) { cap = false; next(); continue; }
        if (m.error) { clearTimeout(t); s.destroy(); return rej(new Error(m.error.desc)); }
        out.push(m.return); next();
      }
    });
    s.on('error', e => { clearTimeout(t); rej(e); });
    if (port !== ports.qmp) s.on('connect', next);
  });
}
const qmp = c => jsonRpc(ports.qmp, [c]);
async function guestExec(cmd, timeoutMs = 600000) {
  if (!qemu) throw new Error('Linux не запущен');
  const sync = Math.floor(Math.random() * 1e9);
  await jsonRpc(ports.qga, [{ execute: 'guest-sync', arguments: { id: sync } }], 5000);
  const [r] = await jsonRpc(ports.qga, [{ execute: 'guest-exec', arguments: { path: '/bin/bash', arg: ['-lc', cmd], 'capture-output': true } }]);
  const t0 = Date.now();
  for (;;) {
    await new Promise(r => setTimeout(r, 700));
    const [st] = await jsonRpc(ports.qga, [{ execute: 'guest-exec-status', arguments: { pid: r.pid } }]);
    if (st.exited) {
      const dec = b => b ? Buffer.from(b, 'base64').toString('utf8') : '';
      return { code: st.exitcode, out: dec(st['out-data']) + dec(st['err-data']) };
    }
    if (Date.now() - t0 > timeoutMs) throw new Error('Превышено время ожидания');
  }
}
const asUser = c => `su - pingvin -c ${JSON.stringify('export DISPLAY=:0 XAUTHORITY=/home/pingvin/.Xauthority; ' + c)}`;
const guestRunGui = c => guestExec(asUser(`setsid nohup ${c} >/dev/null 2>&1 &`), 20000);

// ---------- IPC ----------
ipcMain.handle('status', () => ({ state, accel: accelUsed, imageReady: imageReady(), cfg: { ...cfg, token: cfg.token ? '***' : '' }, ws: ports && ports.ws, dataDir: DATA, platform: process.platform }));
ipcMain.handle('start', () => startVM());
ipcMain.handle('stop', async () => { if (!qemu) return true; try { await qmp({ execute: 'system_powerdown' }); } catch { qemu.kill(); } setTimeout(() => qemu && qemu.kill(), 60000); return true; });
ipcMain.handle('kill', () => { if (qemu) qemu.kill(); return true; });
ipcMain.handle('reset-disk', () => { if (qemu) return false; try { fs.unlinkSync(DISK); } catch {} log('Диск сброшен к исходному образу'); return true; });
ipcMain.handle('import', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Выберите образ (.qcow2 или все части .partNN)', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Образ Пингвинопитека', extensions: ['qcow2', 'part00', 'part01', 'part02', 'part03', '*'] }] });
  if (r.canceled) return false; await importParts(r.filePaths); return true;
});
ipcMain.handle('download', async () => { await downloadImage(); return true; });
ipcMain.handle('save-settings', (e, s) => {
  if (typeof s.token === 'string' && s.token !== '***') cfg.token = s.token ? safeStorage.encryptString(s.token).toString('base64') : '';
  for (const k of ['ramMB', 'cpus', 'accel', 'shareDir', 'imageTag']) if (s[k] !== undefined) cfg[k] = s[k];
  cfg.ramMB = Math.max(1024, +cfg.ramMB | 0); cfg.cpus = Math.max(1, +cfg.cpus | 0); saveCfg(cfg); return true;
});
ipcMain.handle('pick-share', async () => { const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle('open-share', () => { fs.mkdirSync(cfg.shareDir, { recursive: true }); shell.openPath(cfg.shareDir); });
ipcMain.handle('apps', async () => {
  const r = await guestExec(`for f in /usr/share/applications/*.desktop /home/pingvin/.local/share/applications/*.desktop; do [ -f "$f" ] || continue; grep -q '^NoDisplay=true' "$f" && continue; n=$(grep -m1 '^Name\\[ru\\]=' "$f" | cut -d= -f2-); [ -z "$n" ] && n=$(grep -m1 '^Name=' "$f" | cut -d= -f2-); c=$(grep -m1 '^Categories=' "$f" | cut -d= -f2-); echo "$(basename "$f" .desktop)|$n|$c"; done`, 30000);
  return r.out.split('\n').filter(Boolean).map(l => { const [id, name, cat] = l.split('|'); return { id, name, cat }; }).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
});
ipcMain.handle('launch', (e, id) => guestRunGui(`gtk-launch ${JSON.stringify(id).slice(1, -1).replace(/[^\w.@+-]/g, '')}`));
ipcMain.handle('install-pkg', async (e, pkgs) => {
  const list = String(pkgs).split(/[\s,]+/).filter(p => /^[a-z0-9][a-z0-9.+-]*$/.test(p));
  if (!list.length) return { code: 1, out: 'Укажите имя пакета (например: gimp vlc libreoffice-writer)' };
  return guestExec(`export DEBIAN_FRONTEND=noninteractive; (apt-get update -q >/dev/null 2>&1 || true); apt-get install -y -q ${list.join(' ')} 2>&1 | tail -n 25`);
});
ipcMain.handle('search-pkg', (e, q) => guestExec(`apt-cache search --names-only ${JSON.stringify(String(q).replace(/[^\wА-я .+-]/g, ''))} 2>/dev/null | head -n 40`, 60000));
ipcMain.handle('ai-task', async (e, task) => {
  // кладём задачу в буфер обмена Linux и выводим ИванОператор на передний план
  const b64 = Buffer.from(String(task), 'utf8').toString('base64');
  await guestExec(asUser(`echo ${b64} | base64 -d > /tmp/pingvinopitek-task.txt; xclip -selection clipboard -i /tmp/pingvinopitek-task.txt; (xdotool search --class ivan-operator windowactivate 2>/dev/null || xdotool search --name ИванОператор windowactivate 2>/dev/null) || (setsid nohup /opt/ИванОператор/ivan-operator --no-sandbox >/dev/null 2>&1 &)`), 20000);
  return true;
});
ipcMain.handle('ai-open', () => guestRunGui('/opt/ИванОператор/ivan-operator --no-sandbox'));
ipcMain.handle('terminal', (e, c) => guestExec(String(c), 120000));
ipcMain.handle('screenshot', async () => {
  const f = path.join(app.getPath('pictures'), 'Пингвинопитек-' + Date.now() + '.ppm');
  await qmp({ execute: 'screendump', arguments: { filename: f } }); shell.showItemInFolder(f); return f;
});
ipcMain.handle('open-log', () => shell.openPath(path.join(DATA, 'pingvinopitek.log')));

function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 900, minHeight: 600, title: 'Пингвинопитек', backgroundColor: '#0e2233',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.webContents.on('console-message', (e, lvl, msg, line, src) => { if (lvl >= 2) log('[ui] ' + msg + ' ' + src + ':' + line); });
  win.loadFile(path.join(__dirname, 'index.html'));
  if (process.env.PINGVINOPITEK_AUTOSTART) win.webContents.once('did-finish-load', () => send('autostart'));
}
app.whenReady().then(createWindow);
app.on('window-all-closed', async () => {
  if (qemu) { try { await qmp({ execute: 'system_powerdown' }); } catch {} setTimeout(() => { if (qemu) qemu.kill(); app.quit(); }, 15000); }
  else app.quit();
});
process.on('exit', () => { try { qemu && qemu.kill(); } catch {} });
