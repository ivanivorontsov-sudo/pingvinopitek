import RFB from '../node_modules/@novnc/novnc/core/rfb.js';
const $ = s => document.querySelector(s);
let rfb = null, apps = [];
const log = s => { $('#log').textContent = s; };
ppt.on('log', log);
ppt.on('progress', (f, what) => { $('#progress').hidden = false; $('#progress i').style.width = (f * 100).toFixed(1) + '%'; $('#progress span').textContent = ` ${what}: ${(f * 100).toFixed(1)}%`; });
ppt.on('state', (s, acc) => showState(s, acc));
ppt.on('autostart', () => start());
const names = { stopped: 'выключен', starting: 'запускается…', running: 'работает' };
function showState(s, acc) {
  $('#state').textContent = names[s] + (acc ? ' · ' + (acc === 'tcg' ? 'без ускорения' : acc.toUpperCase()) : '');
  $('#state').className = 'pill ' + s;
  if (s === 'stopped' && rfb) { rfb.disconnect(); rfb = null; $('#welcome').hidden = false; }
}
async function refresh() {
  const st = await ppt.status();
  showState(st.state, st.accel);
  $('#noImage').hidden = st.imageReady;
  $('#sRam').value = st.cfg.ramMB; $('#sCpu').value = st.cfg.cpus; $('#sAccel').value = st.cfg.accel;
  $('#sShare').value = st.cfg.shareDir; $('#sToken').value = st.cfg.token; $('#sTag').value = st.cfg.imageTag;
  $('#dataDir').textContent = 'Данные: ' + st.dataDir;
  return st;
}
function connect(ws) {
  $('#welcome').hidden = true;
  rfb = new RFB($('#screen'), `ws://127.0.0.1:${ws}`, { shared: true });
  rfb.scaleViewport = true; rfb.focusOnClick = true;
  rfb.addEventListener('disconnect', () => { if (rfb) setTimeout(async () => { const st = await ppt.status(); if (st.state === 'running') connect(st.ws); }, 1500); rfb = null; });
  rfb.addEventListener('clipboard', e => navigator.clipboard.writeText(e.detail.text).catch(() => {}));
}
// буфер обмена Windows → Linux при возврате в окно
window.addEventListener('focus', async () => { if (rfb) try { rfb.clipboardPasteFrom(await navigator.clipboard.readText()); } catch {} });
async function start() {
  const st = await refresh();
  if (!st.imageReady) { log('Сначала установите образ Linux'); return; }
  const r = await ppt.start();
  if (!r.ok) { log('Не удалось запустить: ' + r.err); alert('Не удалось запустить Linux:\n' + r.err); return; }
  setTimeout(async () => connect((await ppt.status()).ws), 800);
}
$('#bStart').onclick = start;
$('#bStop').onclick = () => ppt.stop();
$('#bFull').onclick = () => document.fullscreenElement ? document.exitFullscreen() : $('#screen').requestFullscreen();
$('#bShare').onclick = () => ppt.openShare();
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
  const id = 'tab-' + b.dataset.tab; const p = $('#panel');
  const same = !p.hidden && !$('#' + id).hidden; p.hidden = same;
  document.querySelectorAll('.tab').forEach(t => t.hidden = t.id !== id);
  if (!same && id === 'tab-apps') loadApps();
});
async function loadApps() {
  try { apps = await ppt.apps(); } catch (e) { $('#appList').innerHTML = '<p class="hint">' + e.message + '</p>'; return; }
  drawApps();
}
function drawApps() {
  const q = $('#appFilter').value.toLowerCase(); const el = $('#appList'); el.innerHTML = '';
  for (const a of apps.filter(a => a.name.toLowerCase().includes(q))) {
    const b = document.createElement('button'); b.className = 'app'; b.textContent = a.name; b.onclick = () => ppt.launch(a.id); el.append(b);
  }
}
$('#appFilter').oninput = drawApps;
$('#bAiOpen').onclick = () => ppt.aiOpen().catch(e => log(e.message));
$('#bAiSend').onclick = () => ppt.aiTask($('#aiTask').value).then(() => log('Задача передана: вставьте её в ИванОператор (Ctrl+V)')).catch(e => log(e.message));
$('#cmd').onkeydown = async e => { if (e.key === 'Enter') { $('#cmdOut').textContent = '…'; try { const r = await ppt.terminal($('#cmd').value); $('#cmdOut').textContent = r.out + (r.code ? `\n[код ${r.code}]` : ''); } catch (er) { $('#cmdOut').textContent = er.message; } } };
const popular = { 'GIMP': 'gimp', 'VLC': 'vlc', 'LibreOffice': 'libreoffice-writer libreoffice-calc libreoffice-l10n-ru', 'Chromium': 'chromium chromium-l10n', 'Inkscape': 'inkscape', 'Krita': 'krita', 'Audacity': 'audacity', 'VS Codium-подобный Geany': 'geany', 'Telegram (через flatpak)': 'flatpak', 'Wine': 'wine', 'Steam-игры: SuperTux': 'supertux', 'Blender': 'blender', 'OBS': 'obs-studio', 'qBittorrent': 'qbittorrent' };
for (const [n, p] of Object.entries(popular)) { const b = document.createElement('button'); b.textContent = n; b.onclick = () => { $('#pkgQ').value = p; }; $('#chips').append(b); }
$('#bPkgSearch').onclick = async () => { $('#pkgOut').textContent = 'Поиск…'; try { $('#pkgOut').textContent = (await ppt.searchPkg($('#pkgQ').value)).out || 'Ничего не найдено'; } catch (e) { $('#pkgOut').textContent = e.message; } };
$('#bPkgInstall').onclick = async () => { $('#pkgOut').textContent = 'Устанавливаю… (может занять несколько минут)'; try { const r = await ppt.installPkg($('#pkgQ').value); $('#pkgOut').textContent = r.out + (r.code ? '\nОшибка, код ' + r.code : '\nГотово — программа появится в меню и в «Программах».'); } catch (e) { $('#pkgOut').textContent = e.message; } };
$('#bSynaptic').onclick = () => ppt.launch('synaptic');
$('#bPickShare').onclick = async () => { const d = await ppt.pickShare(); if (d) $('#sShare').value = d; };
$('#bSave').onclick = async () => { await ppt.saveSettings({ ramMB: +$('#sRam').value, cpus: +$('#sCpu').value, accel: $('#sAccel').value, shareDir: $('#sShare').value, token: $('#sToken').value, imageTag: $('#sTag').value }); log('Настройки сохранены (применятся при следующем запуске Linux)'); refresh(); };
const imp = async () => { try { if (await ppt.import()) { log('Образ установлен'); refresh(); } } catch (e) { alert(e.message); } };
$('#bImport').onclick = imp; $('#bImport2').onclick = imp;
$('#bDownload').onclick = async () => { try { await ppt.download(); log('Образ скачан и установлен'); $('#progress').hidden = true; refresh(); } catch (e) { alert('Загрузка не удалась: ' + e.message + '\n\nЕсли репозиторий приватный — впишите токен GitHub в настройках или скачайте части образа вручную.'); } };
$('#bReset').onclick = async () => { if (confirm('Вернуть Linux к исходному состоянию? Все изменения внутри Linux будут удалены (общая папка не пострадает).')) log(await ppt.resetDisk() ? 'Сброшено' : 'Сначала выключите Linux'); };
$('#bLog').onclick = () => ppt.openLog();
refresh();
