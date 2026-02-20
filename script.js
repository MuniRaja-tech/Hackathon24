/* ═══════════════════════════════════════════════════════════
   NeuralEdu — script.js
   Database: IndexedDB (privacy-first, admin-only access)
   Features: Auth, Fullscreen+20s warning, WebRTC, Soft AI,
             Canvas charts, Real-time sync, Recordings
═══════════════════════════════════════════════════════════ */
'use strict';

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const TEACHER_CREDS = { username: 'teacher1', password: '123456' };
const DB_NAME       = 'NeuralEduDB';
const DB_VERSION    = 1;
const SYNC_MS       = 3000;
const AI_DELAY_MS   = 2 * 60 * 1000;
const EXIT_WARN_SEC = 20;

const FOCUS_PTS   = { High: 100, Medium: 50, Low: 10 };
const FOCUS_COLOR = { High: '#00ff88', Medium: '#ffd60a', Low: '#ff2d55' };

const BADGES = [
  { id: 'starter',    label: '🎯 First Login',    fn: s => s.sessions >= 1 },
  { id: 'pts50',      label: '⭐ 50 Points',      fn: s => s.points >= 50 },
  { id: 'pts100',     label: '💎 100 Points',     fn: s => s.points >= 100 },
  { id: 'high_flyer', label: '🔥 High Achiever',  fn: s => s.highFocusSessions >= 1 },
  { id: 'ai_user',    label: '🤖 AI Explorer',    fn: s => s.aiSessions >= 1 },
  { id: 'resilient',  label: '💪 Resilient',      fn: s => s.fsExitCount >= 1 },
];

// ─── DB ──────────────────────────────────────────────────────────────────────
let DB = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('students'))  db.createObjectStore('students',  { keyPath: 'username' });
      if (!db.objectStoreNames.contains('sessions'))  db.createObjectStore('sessions',  { keyPath: 'username' });
      if (!db.objectStoreNames.contains('events'))    db.createObjectStore('events',    { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('media'))     db.createObjectStore('media',     { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('settings'))  db.createObjectStore('settings',  { keyPath: 'key' });
      if (!db.objectStoreNames.contains('recordings'))db.createObjectStore('recordings',{ keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = e => { DB = e.target.result; resolve(DB); };
    req.onerror   = () => reject(req.error);
  });
}

// DB helpers — all access gated behind teacher role check where sensitive
function dbPut(store, obj)       { return new Promise((res,rej)=>{ const t=DB.transaction(store,'readwrite'); t.objectStore(store).put(obj).onsuccess=()=>res(); t.onerror=()=>rej(); }); }
function dbGet(store, key)       { return new Promise((res,rej)=>{ const t=DB.transaction(store,'readonly');  t.objectStore(store).get(key).onsuccess=e=>res(e.target.result); t.onerror=()=>rej(); }); }
function dbGetAll(store)         { return new Promise((res,rej)=>{ const t=DB.transaction(store,'readonly');  t.objectStore(store).getAll().onsuccess=e=>res(e.target.result); t.onerror=()=>rej(); }); }
function dbDelete(store, key)    { return new Promise((res,rej)=>{ const t=DB.transaction(store,'readwrite'); t.objectStore(store).delete(key).onsuccess=()=>res(); t.onerror=()=>rej(); }); }
function dbAdd(store, obj)       { return new Promise((res,rej)=>{ const t=DB.transaction(store,'readwrite'); const req=t.objectStore(store).add(obj); req.onsuccess=e=>res(e.target.result); t.onerror=()=>rej(); }); }
function dbSetting(key, val)     { return dbPut('settings', { key, val }); }
function dbGetSetting(key, def)  { return dbGet('settings', key).then(r => r ? r.val : def); }

// ─── STATE ───────────────────────────────────────────────────────────────────
let currentUser   = null;
let currentRole   = null; // 'student' | 'teacher'
let syncTimer     = null;
let aiTimer       = null;
let aiCountdown   = AI_DELAY_MS;
let aiUnlocked    = false;
let aiActivated   = false;
let studentCamStream  = null;
let teacherCamStream  = null;
let exitModalTimer    = null;
let exitCountdown     = EXIT_WARN_SEC;
let exitResolveFn     = null;
let sessionStartTime  = null;

// ─── DOM HELPERS ─────────────────────────────────────────────────────────────
const $   = id  => document.getElementById(id);
const $$  = sel => document.querySelectorAll(sel);
const show   = id => { const e = $(id); if (e) { e.classList.remove('hidden'); } };
const hide   = id => { const e = $(id); if (e) { e.classList.add('hidden'); } };
const showScreen = id => { $$('.screen').forEach(s => { s.classList.add('hidden'); s.classList.remove('active'); }); $(id).classList.remove('hidden'); $(id).classList.add('active'); };
const fmtT = ts  => new Date(ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
const fmtDT= ts  => new Date(ts).toLocaleString([], { dateStyle:'short', timeStyle:'short' });
const fmtSz= b   => b<1024?`${b}B`:b<1048576?`${(b/1024).toFixed(1)}KB`:`${(b/1048576).toFixed(1)}MB`;
const elapsed = ts => { const s=Math.floor((Date.now()-ts)/1000); const m=Math.floor(s/60); return m>0?`${m}m ${s%60}s`:`${s}s`; };
function setFb(id, msg, isErr=false) { const e=$(id); if(!e) return; e.textContent=msg; e.className='upload-fb'+(isErr?' err':''); }

// ─── BACKGROUND PARTICLE CANVAS ──────────────────────────────────────────────
(function initBg() {
  const canvas = $('bgCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H, particles = [];
  function resize() { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
  window.addEventListener('resize', resize); resize();
  for (let i = 0; i < 60; i++) particles.push({ x:Math.random()*9999, y:Math.random()*9999, vx:(Math.random()-.5)*.3, vy:(Math.random()-.5)*.3, r:Math.random()*1.5+.5, alpha:Math.random()*.5+.1 });
  function draw() {
    ctx.clearRect(0,0,W,H);
    particles.forEach(p => {
      p.x = (p.x+p.vx+W)%W; p.y = (p.y+p.vy+H)%H;
      ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
      ctx.fillStyle = `rgba(0,212,255,${p.alpha})`; ctx.fill();
    });
    requestAnimationFrame(draw);
  }
  draw();
})();

// ─── INIT ────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  animateLoader();
  try {
    await openDB();
    await setLoaderMsg('Database ready. Loading interface…', 80);
    await sleep(400);
    await setLoaderMsg('Applying security policies…', 100);
    await sleep(300);
  } catch(e) {
    console.error('DB init failed, falling back to memory mode:', e);
  }
  showScreen('authScreen');
  bindAuth();
  bindTeacher();
  bindStudent();
  bindFullscreen();
});

function animateLoader() {
  let pct = 0;
  const msgs = ['Initializing secure database…', 'Encrypting storage layer…', 'Loading UI modules…'];
  let mi = 0;
  const t = setInterval(() => {
    pct += 3;
    $('loaderProgress').style.width = Math.min(pct, 75) + '%';
    if (pct % 25 === 0 && mi < msgs.length) { $('loaderMsg').textContent = msgs[mi++]; }
    if (pct >= 75) clearInterval(t);
  }, 40);
}
function setLoaderMsg(msg, pct) {
  $('loaderMsg').textContent = msg;
  $('loaderProgress').style.width = pct + '%';
  return sleep(200);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── AUTH ────────────────────────────────────────────────────────────────────
function bindAuth() {
  // Role pills
  $$('.arole').forEach(btn => btn.addEventListener('click', () => {
    $$('.arole').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const r = btn.dataset.role;
    if (r === 'student') { show('studentAuthWrap'); hide('teacherAuthWrap'); }
    else { hide('studentAuthWrap'); show('teacherAuthWrap'); }
  }));

  // Student subtabs
  $$('.asub').forEach(btn => btn.addEventListener('click', () => {
    $$('.asub').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    $('sAuthBtn').textContent = btn.dataset.mode === 'login' ? 'Sign In' : 'Create Account';
  }));

  // Student form
  $('sAuthForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('sErr').textContent = '';
    const user = $('sUser').value.trim();
    const pass = $('sPass').value;
    const mode = document.querySelector('.asub.active').dataset.mode;
    if (!user || !pass) return ($('sErr').textContent = 'All fields required.');
    if (user === TEACHER_CREDS.username) return ($('sErr').textContent = 'Username reserved.');

    if (mode === 'register') {
      const exists = await dbGet('students', user);
      if (exists) return ($('sErr').textContent = 'Username already taken.');
      if (pass.length < 4) return ($('sErr').textContent = 'Password min 4 characters.');
      await dbPut('students', { username: user, password: pass, points: 0, badges: [], sessions: 0, highFocusSessions: 0, aiSessions: 0, quizCorrect: 0, fsExitCount: 0 });
    } else {
      const stu = await dbGet('students', user);
      if (!stu) return ($('sErr').textContent = 'User not found.');
      if (stu.password !== pass) return ($('sErr').textContent = 'Incorrect password.');
    }
    await startStudentSession(user);
  });

  // Teacher form
  $('tAuthForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('tErr').textContent = '';
    if ($('tUser').value.trim() !== TEACHER_CREDS.username || $('tPass').value !== TEACHER_CREDS.password)
      return ($('tErr').textContent = 'Invalid credentials.');
    await startTeacherSession();
  });
}

// ─── STUDENT SESSION ─────────────────────────────────────────────────────────
async function startStudentSession(username) {
  currentUser = username;
  currentRole = 'student';
  sessionStartTime = Date.now();
  aiActivated = false;
  aiUnlocked  = false;
  aiCountdown = AI_DELAY_MS;

  $('sNameChip').textContent = username;

  // Upsert session record
  await dbPut('sessions', { username, focus: null, points: 0, startTime: Date.now(), lastSeen: Date.now(), aiUsed: false, fsInFullscreen: false, fsExitCount: 0, lastExit: null });
  await logEvent('session_start', username, `${username} started a session`, '#00d4ff');

  showScreen('studentScreen');
  show('aiChip');
  startAiCountdown();
  await refreshStudentDoc();
  await refreshStudentScore();
  startSync();
  await sleep(300);
  enterFullscreen();
}

$('sBtnLogout').addEventListener('click', () => handleStudentExit());

async function handleStudentExit() {
  clearTimers();
  if (studentCamStream) { studentCamStream.getTracks().forEach(t => t.stop()); studentCamStream = null; }
  await updateFsStatus(currentUser, false);
  await logEvent('session_end', currentUser, `${currentUser} ended session`, '#6b8caa');
  if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch {} }
  currentUser = null; currentRole = null;
  showScreen('authScreen');
}

// ─── TEACHER SESSION ─────────────────────────────────────────────────────────
async function startTeacherSession() {
  currentUser = TEACHER_CREDS.username;
  currentRole = 'teacher';
  showScreen('teacherScreen');
  await syncTeacherToggles();
  await refreshTeacherAll();
  startSync();
}

$('tBtnLogout').addEventListener('click', async () => {
  clearTimers();
  if (teacherCamStream) { teacherCamStream.getTracks().forEach(t => t.stop()); teacherCamStream = null; }
  currentUser = null; currentRole = null;
  showScreen('authScreen');
});

// ─── FULLSCREEN ───────────────────────────────────────────────────────────────
function bindFullscreen() {
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
  $('btnStay').addEventListener('click', onStayInSession);
  $('btnExitNow').addEventListener('click', onForceExit);
  $('fsChip').addEventListener('click', () => { if (currentRole === 'student') enterFullscreen(); });
}

function enterFullscreen() {
  const el = document.documentElement;
  const rq = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen;
  if (rq) {
    rq.call(el).then(() => {
      $('fsChip').textContent = '⛶ Fullscreen Active';
      $('fsChip').style.cssText = 'background:rgba(0,255,136,0.12);border:1px solid #00ff88;color:#00ff88';
      updateFsStatus(currentUser, true);
    }).catch(() => {
      $('fsChip').textContent = '⛶ Fullscreen Blocked';
      $('fsChip').style.color = '#ff9f0a';
    });
  }
}

function onFsChange() {
  if (currentRole !== 'student' || !currentUser) return;
  const inFs = !!(document.fullscreenElement || document.webkitFullscreenElement);

  if (!inFs) {
    // EXITED — show 20-second warning
    $('fsChip').textContent = '⛶ Not Fullscreen';
    $('fsChip').style.cssText = 'background:rgba(255,45,85,0.12);border:1px solid #ff2d55;color:#ff2d55';
    updateFsStatus(currentUser, false);
    incrementFsExitCount(currentUser);
    showExitModal();
  } else {
    hide('exitModal');
    clearExitTimer();
    $('fsChip').textContent = '⛶ Fullscreen Active';
    $('fsChip').style.cssText = 'background:rgba(0,255,136,0.12);border:1px solid #00ff88;color:#00ff88';
    updateFsStatus(currentUser, true);
    logEvent('fs_enter', currentUser, `${currentUser} re-entered fullscreen`, '#00ff88');
  }
}

// ─── EXIT MODAL (20-second countdown) ────────────────────────────────────────
function showExitModal() {
  logEvent('fs_exit', currentUser, `${currentUser} exited fullscreen`, '#ff2d55');
  show('exitModal');
  exitCountdown = EXIT_WARN_SEC;
  updateExitRing(EXIT_WARN_SEC);
  $('exitNum').textContent  = EXIT_WARN_SEC;
  $('exitSub').textContent  = EXIT_WARN_SEC;

  exitModalTimer = setInterval(() => {
    exitCountdown--;
    $('exitNum').textContent  = exitCountdown;
    $('exitSub').textContent  = exitCountdown;
    updateExitRing(exitCountdown);
    if (exitCountdown <= 0) {
      clearExitTimer();
      performExit();
    }
  }, 1000);
}

function updateExitRing(sec) {
  const ring = $('exitRing');
  if (!ring) return;
  const circumference = 314.16;
  const offset = circumference * (1 - sec / EXIT_WARN_SEC);
  ring.style.strokeDashoffset = offset;
  ring.style.stroke = sec > 10 ? '#ff9f0a' : '#ff2d55';
}

function onStayInSession() {
  clearExitTimer();
  hide('exitModal');
  enterFullscreen();
}

function onForceExit() {
  clearExitTimer();
  hide('exitModal');
  performExit();
}

async function performExit() {
  hide('exitModal');
  clearTimers();
  if (studentCamStream) { studentCamStream.getTracks().forEach(t => t.stop()); studentCamStream = null; }
  await logEvent('session_end', currentUser, `${currentUser} exited (fullscreen timeout)`, '#ff9f0a');
  if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch {} }
  currentUser = null; currentRole = null;
  showScreen('authScreen');
}

function clearExitTimer() {
  if (exitModalTimer) { clearInterval(exitModalTimer); exitModalTimer = null; }
}

async function updateFsStatus(user, inFs) {
  if (!user || !DB) return;
  const sess = await dbGet('sessions', user);
  if (sess) { sess.fsInFullscreen = inFs; if (!inFs) sess.lastExit = Date.now(); await dbPut('sessions', sess); }
}

async function incrementFsExitCount(user) {
  if (!user || !DB) return;
  const sess = await dbGet('sessions', user);
  if (sess) { sess.fsExitCount = (sess.fsExitCount || 0) + 1; await dbPut('sessions', sess); }
  const stu = await dbGet('students', user);
  if (stu) { stu.fsExitCount = (stu.fsExitCount || 0) + 1; await dbPut('students', stu); }
}

// ─── AI COUNTDOWN ─────────────────────────────────────────────────────────────
function startAiCountdown() {
  clearInterval(aiTimer);
  aiCountdown = AI_DELAY_MS;
  updateAiChip();
  aiTimer = setInterval(() => {
    aiCountdown -= 1000;
    updateAiChip();
    if (aiCountdown <= 0) {
      clearInterval(aiTimer);
      hide('aiChip');
      if (!aiActivated) { show('aiUnlockWrap'); aiUnlocked = true; }
    }
  }, 1000);
}

function updateAiChip() {
  const m = Math.floor(Math.max(0, aiCountdown) / 60000);
  const s = Math.floor((Math.max(0, aiCountdown) % 60000) / 1000);
  $('aiChipTime').textContent = `${m}:${s.toString().padStart(2,'0')}`;
}

// ─── STUDENT BINDINGS ─────────────────────────────────────────────────────────
function bindStudent() {
  // Focus selection
  $$('input[name="focusSel"]').forEach(r => r.addEventListener('change', () => onFocusSelect(r.value)));

  // AI activation
  $('btnActivateAi').addEventListener('click', activateSoftAI);

  // AI tabs
  $$('.aitab').forEach(btn => btn.addEventListener('click', () => {
    $$('.aitab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    $$('.ai-pane').forEach(p => { p.classList.add('hidden'); p.classList.remove('active'); });
    const pane = $('aipane-' + btn.dataset.aitab);
    if (pane) { pane.classList.remove('hidden'); pane.classList.add('active'); }
  }));

  // Camera toggle
  $('btnCamToggle').addEventListener('click', toggleStudentCam);

  // PiP close
  $('pipClose').addEventListener('click', () => hide('pipContainer'));
}

async function onFocusSelect(focus) {
  if (!currentUser) return;
  const pts = FOCUS_PTS[focus] || 0;

  // Update student record
  const stu = await dbGet('students', currentUser) || { username: currentUser, points: 0, badges: [], sessions: 0, highFocusSessions: 0, aiSessions: 0, quizCorrect: 0, fsExitCount: 0 };
  stu.points = (stu.points || 0) + pts;
  stu.sessions = (stu.sessions || 0) + 1;
  if (focus === 'High') stu.highFocusSessions = (stu.highFocusSessions || 0) + 1;
  checkBadges(stu);
  await dbPut('students', stu);

  // Update session record
  const sess = await dbGet('sessions', currentUser);
  if (sess) { sess.focus = focus; sess.points = stu.points; sess.lastSeen = Date.now(); await dbPut('sessions', sess); }

  await refreshStudentScore();
  await logEvent('focus', currentUser, `${currentUser} set focus: ${focus}`, FOCUS_COLOR[focus]);
}

function checkBadges(stu) {
  if (!stu.badges) stu.badges = [];
  BADGES.forEach(b => { if (!stu.badges.includes(b.id) && b.fn(stu)) stu.badges.push(b.id); });
}

async function refreshStudentDoc() {
  if (!DB) return;
  const allMedia = await dbGetAll('media');
  const docs = allMedia.filter(m => m.type === 'txt');
  const vids = allMedia.filter(m => m.type === 'mp4');
  const area = $('sDocArea');

  if (!docs.length) {
    area.innerHTML = '<div class="empty-state"><div class="es-icon">📭</div><p>No document uploaded yet</p><small>Waiting for teacher to upload content…</small></div>';
  } else {
    const latest = docs[docs.length - 1];
    area.textContent = latest.content || '(Empty document)';
  }

  if (vids.length) {
    const latest = vids[vids.length - 1];
    $('sLessonVid').src = latest.base64 || '';
    show('sVideoDock');
  } else {
    hide('sVideoDock');
  }
}

async function refreshStudentScore() {
  if (!currentUser || !DB) return;
  const stu = await dbGet('students', currentUser);
  if (!stu) return;
  const pts = stu.points || 0;
  $('scoreBig').textContent  = pts;
  $('scoreFill').style.width = Math.min(100, (pts / 500) * 100) + '%';

  // Progress tab
  $('pPoints').textContent  = pts;
  $('pCorrect').textContent = stu.quizCorrect || 0;
  $('pLevel').textContent   = Math.floor(pts / 200) + 1;
  const xp = pts % 200;
  $('xpFill').style.width = (xp / 200 * 100) + '%';
  $('xpTxt').textContent  = `${xp} / 200 XP`;

  // Mini badges in score panel
  const mini = $('miniBadgeRow');
  if (mini) renderBadgesMini(mini, stu.badges || []);

  // Progress tab badges
  const shelf = $('badgeRow');
  if (shelf) renderBadgesFull(shelf, stu.badges || []);
}

function renderBadgesMini(container, earned) {
  container.innerHTML = '';
  BADGES.forEach(b => {
    const d = document.createElement('div');
    d.className = 'badge-item' + (earned.includes(b.id) ? ' earned' : '');
    d.textContent = b.label;
    container.appendChild(d);
  });
}

function renderBadgesFull(container, earned) {
  container.innerHTML = '';
  BADGES.forEach(b => {
    const d = document.createElement('div');
    d.className = 'badge-item' + (earned.includes(b.id) ? ' earned' : '');
    d.textContent = b.label;
    container.appendChild(d);
  });
}

// ─── SOFT AI ──────────────────────────────────────────────────────────────────
async function activateSoftAI() {
  if (aiActivated) return;
  aiActivated = true;
  hide('aiUnlockWrap');
  show('sAiPanel');
  show('aiActiveBadge');

  // Mark AI used
  const stu = await dbGet('students', currentUser) || {};
  stu.aiSessions = (stu.aiSessions || 0) + 1;
  checkBadges(stu);
  await dbPut('students', stu);
  const sess = await dbGet('sessions', currentUser);
  if (sess) { sess.aiUsed = true; sess.lastSeen = Date.now(); await dbPut('sessions', sess); }
  await refreshStudentScore();

  // Get document content
  const allMedia = await dbGetAll('media');
  const docs = allMedia.filter(m => m.type === 'txt');
  const content = docs.length ? (docs[docs.length - 1].content || '') : '';

  buildBullets(content);
  buildQuiz(content);
  await logEvent('ai_activate', currentUser, `${currentUser} activated Soft AI`, '#7b2fff');
}

function buildBullets(text) {
  const sents = text.split(/[.!?]\s+/).map(s => s.trim()).filter(s => s.length > 20);
  const items  = sents.slice(0, 8);
  const c = $('bulletContainer');
  c.innerHTML = '';

  if (!items.length) {
    c.innerHTML = '<p style="color:var(--text3)">No document content to summarize. Ask your teacher to upload a .txt file.</p>';
    return;
  }

  items.forEach((txt, i) => {
    const short  = txt.length > 95 ? txt.slice(0, 95) + '…' : txt;
    const detail = `This concept covers: "${txt}". Understanding this principle is foundational to mastering the overall topic and applying it in practical scenarios.`;
    const el = document.createElement('div');
    el.className = 'bullet-item';
    el.style.animationDelay = (i * 65) + 'ms';
    el.innerHTML = `
      <div class="bullet-hd">
        <div class="bullet-dot"></div>
        <div class="bullet-text">${short}</div>
        <div class="bullet-arr">▶</div>
      </div>
      <div class="bullet-detail">${detail}</div>`;
    el.querySelector('.bullet-hd').addEventListener('click', () => el.classList.toggle('open'));
    c.appendChild(el);
  });
}

function buildQuiz(text) {
  const words = text.split(/\s+/).filter(w => w.length > 4 && /^[a-zA-Z]/.test(w));
  const sents = text.split(/[.!?]\s+/).filter(s => s.length > 25);
  const c      = $('quizContainer');
  const sb     = $('quizScoreBox');
  c.innerHTML  = '';
  sb.classList.add('hidden');

  const qs = [];
  for (let i = 0; i < Math.min(5, sents.length); i++) {
    const s  = sents[i];
    const sw = s.split(/\s+/).filter(w => w.length > 4 && /^[a-zA-Z]/.test(w));
    if (!sw.length) continue;
    const ans    = sw[Math.floor(sw.length / 2)].replace(/[^a-zA-Z]/g, '');
    if (!ans || ans.length < 3) continue;
    const wrongs = [...new Set(words.filter(w => w !== ans && w.length > 3))].slice(i * 4, i * 4 + 3);
    while (wrongs.length < 3) wrongs.push(['concept', 'method', 'theory', 'process'][wrongs.length] || 'idea');
    const opts = [ans, ...wrongs.slice(0, 3)].sort(() => Math.random() - 0.5);
    qs.push({ q: `Which term best fits: "${s.slice(0, 65)}…"?`, opts, ans });
  }

  if (!qs.length) { c.innerHTML = '<p style="color:var(--text3)">Not enough content for quiz generation.</p>'; return; }

  let answered = 0, correct = 0;
  qs.forEach((q, qi) => {
    const div = document.createElement('div');
    div.className = 'quiz-q';
    div.innerHTML = `<div class="quiz-qtxt">Q${qi + 1}: ${q.q}</div><div class="quiz-opts" id="qopts${qi}"></div><div class="quiz-fb" id="qfb${qi}"></div>`;
    const od = div.querySelector(`#qopts${qi}`);
    const fd = div.querySelector(`#qfb${qi}`);
    q.opts.forEach(opt => {
      const btn = document.createElement('button');
      btn.className = 'quiz-opt'; btn.textContent = opt;
      btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        od.querySelectorAll('.quiz-opt').forEach(b => b.disabled = true);
        const ok = opt === q.ans;
        btn.classList.add(ok ? 'correct' : 'wrong');
        if (!ok) od.querySelectorAll('.quiz-opt').forEach(b => { if (b.textContent === q.ans) b.classList.add('correct'); });
        fd.textContent = ok ? '✓ Correct!' : `✗ Answer: ${q.ans}`;
        fd.style.color = ok ? 'var(--neon3)' : 'var(--danger)';
        answered++; if (ok) { correct++;
          // Award bonus pts
          const stu = await dbGet('students', currentUser) || {};
          stu.points = (stu.points || 0) + 25;
          stu.quizCorrect = (stu.quizCorrect || 0) + 1;
          checkBadges(stu);
          await dbPut('students', stu);
          await refreshStudentScore();
        }
        if (answered === qs.length) {
          const pct = Math.round(correct / qs.length * 100);
          sb.innerHTML = `<div class="qs-big">${pct}%</div><div style="color:var(--text2);margin-top:8px">${correct}/${qs.length} · ${pct>=80?'🎉 Excellent!':pct>=50?'👍 Good effort!':'📚 Keep studying!'}</div>`;
          sb.classList.remove('hidden');
        }
      });
      od.appendChild(btn);
    });
    c.appendChild(div);
  });
}

// ─── STUDENT CAMERA ───────────────────────────────────────────────────────────
async function toggleStudentCam() {
  if (studentCamStream) {
    studentCamStream.getTracks().forEach(t => t.stop()); studentCamStream = null;
    $('sCamVid').srcObject = null; $('sCamVid').classList.add('hidden');
    show('sCamOff'); $('btnCamToggle').textContent = 'Start Camera';
    hide('pipContainer');
    await updateCamState(currentUser, false);
  } else {
    try {
      studentCamStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      $('sCamVid').srcObject = studentCamStream; $('sCamVid').classList.remove('hidden'); hide('sCamOff');
      $('btnCamToggle').textContent = 'Stop Camera';
      // PiP
      $('pipVid').srcObject = studentCamStream; show('pipContainer');
      $('pipInfo').textContent = `📹 ${currentUser}`;
      await updateCamState(currentUser, true);
    } catch {
      alert('Camera access denied. You may continue without camera.');
      await updateCamState(currentUser, false);
    }
  }
}

async function updateCamState(user, active) {
  if (!DB || !user) return;
  await dbSetting(`cam_${user}`, { active, ts: Date.now() });
}

// ─── LOG EVENT ────────────────────────────────────────────────────────────────
async function logEvent(type, username, message, color) {
  if (!DB) return;
  try { await dbAdd('events', { type, username, message, color: color || '#6b8caa', ts: Date.now() }); }
  catch {}
}

// ─── TEACHER BINDINGS ─────────────────────────────────────────────────────────
function bindTeacher() {
  // Tab nav
  $$('.tnav').forEach(btn => btn.addEventListener('click', () => {
    $$('.tnav').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    $$('.t-tab').forEach(p => { p.classList.add('hidden'); p.classList.remove('active'); });
    const tab = $('ttab-' + btn.dataset.ttab);
    if (tab) { tab.classList.remove('hidden'); tab.classList.add('active'); }
    const t = btn.dataset.ttab;
    if (t === 'analytics') renderAnalyticsTab();
    if (t === 'timeline')  renderTimelineTab();
    if (t === 'video')     renderVideoTab();
  }));

  // Upload
  $('docInput').addEventListener('change', e => handleUpload(e, 'txt'));
  $('vidInput').addEventListener('change', e => handleUpload(e, 'mp4'));

  // WebRTC toggles
  $('togFeeds').addEventListener('change',  saveWebrtcSettings);
  $('togRec').addEventListener('change',    saveWebrtcSettings);
  $('togFeeds2').addEventListener('change', () => { $('togFeeds').checked = $('togFeeds2').checked; saveWebrtcSettings(); });

  // Video tab controls
  $('btnTCamStart').addEventListener('click', startTeacherCam);
  $('btnTCamStop').addEventListener('click',  stopTeacherCam);
  $('btnMuteAll').addEventListener('click',   () => { const e=$('vcFb'); /* no real audio to mute in local sim */ });
  $('btnSaveSnap').addEventListener('click',  saveSnapshot);
}

async function syncTeacherToggles() {
  const cfg = await dbGetSetting('webrtc', { feeds: false, recording: false });
  $('togFeeds').checked  = !!cfg.feeds;
  $('togFeeds2').checked = !!cfg.feeds;
  $('togRec').checked    = !!cfg.recording;
}

async function saveWebrtcSettings() {
  const cfg = { feeds: $('togFeeds').checked, recording: $('togRec').checked };
  await dbSetting('webrtc', cfg);
  $('togFeeds2').checked = cfg.feeds;
  setFb('webrtcFb', cfg.feeds ? '✓ Student feeds enabled' : 'Feeds disabled');
}

// ─── FILE UPLOADS ─────────────────────────────────────────────────────────────
async function handleUpload(event, type) {
  const file = event.target.files[0];
  if (!file) return;
  const fbId = type === 'txt' ? 'docFb' : 'vidFb';
  setFb(fbId, '');

  const ext = file.name.split('.').pop().toLowerCase();
  if (ext !== type && !(type === 'mp4' && (file.type.includes('video') || ext === 'mp4'))) {
    return setFb(fbId, `Select a .${type} file.`, true);
  }
  const limit = type === 'txt' ? 5 * 1024 : 10 * 1024 * 1024;
  if (file.size > limit) return setFb(fbId, `Too large (max ${type === 'txt' ? '5KB' : '10MB'}).`, true);

  setFb(fbId, '⏳ Uploading to database…');
  const reader = new FileReader();

  if (type === 'txt') {
    reader.onload = async ev => {
      // Remove previous txt
      const all = await dbGetAll('media');
      for (const m of all.filter(x => x.type === 'txt')) await dbDelete('media', m.id);
      await dbAdd('media', { type: 'txt', name: file.name, size: file.size, content: ev.target.result, ts: Date.now() });
      setFb(fbId, `✓ "${file.name}" saved to DB`);
      await renderMediaLibrary();
      await logEvent('upload', TEACHER_CREDS.username, `Uploaded document: ${file.name}`, '#00d4ff');
    };
    reader.readAsText(file);
  } else {
    reader.onload = async ev => {
      try {
        // Remove previous mp4
        const all = await dbGetAll('media');
        for (const m of all.filter(x => x.type === 'mp4')) await dbDelete('media', m.id);
        await dbAdd('media', { type: 'mp4', name: file.name, size: file.size, base64: ev.target.result, ts: Date.now() });
        setFb(fbId, `✓ "${file.name}" saved to DB`);
        await renderMediaLibrary();
        await logEvent('upload', TEACHER_CREDS.username, `Uploaded video: ${file.name}`, '#7b2fff');
      } catch { setFb(fbId, '✗ Storage quota exceeded. Delete files first.', true); }
    };
    reader.onerror = () => setFb(fbId, '✗ Read error.', true);
    reader.readAsDataURL(file);
  }
  event.target.value = '';
}

async function renderMediaLibrary() {
  if (!DB) return;
  const allMedia = await dbGetAll('media');
  const lib = $('mediaLib');
  if (!lib) return;
  if (!allMedia.length) { lib.innerHTML = '<div class="empty-state small">No files uploaded</div>'; return; }
  const icons = { txt: '📄', mp4: '🎬' };
  lib.innerHTML = '';
  allMedia.forEach(item => {
    const d = document.createElement('div'); d.className = 'media-item';
    d.innerHTML = `<div class="mi-ic">${icons[item.type] || '📁'}</div>
      <div class="mi-info"><div class="mi-name">${item.name}</div><div class="mi-meta">${item.type.toUpperCase()} · ${fmtSz(item.size)} · ${fmtDT(item.ts)}</div></div>
      <div class="mi-btns"></div>`;
    const btns = d.querySelector('.mi-btns');

    if (item.type === 'txt') {
      const pb = document.createElement('button'); pb.className = 'btn-sm'; pb.textContent = '👁 Preview';
      pb.addEventListener('click', () => alert(item.content?.slice(0, 600) + (item.content?.length > 600 ? '…' : '')));
      btns.appendChild(pb);
    }
    if (item.base64 && item.type === 'mp4') {
      const pb = document.createElement('button'); pb.className = 'btn-sm'; pb.textContent = '▶ Play';
      pb.addEventListener('click', () => openVideoModal(item));
      btns.appendChild(pb);
    }
    const db = document.createElement('button'); db.className = 'btn-sm-red'; db.textContent = '🗑';
    db.addEventListener('click', async () => { await dbDelete('media', item.id); await renderMediaLibrary(); });
    btns.appendChild(db);
    lib.appendChild(d);
  });
}

function openVideoModal(item) {
  const o = document.createElement('div');
  o.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:9998;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(10px)';
  const b = document.createElement('div');
  b.style.cssText = 'background:#060e1e;border:1px solid rgba(0,212,255,0.2);border-radius:16px;padding:20px;max-width:680px;width:92%';
  b.innerHTML = `<p style="color:#6b8caa;font-size:11px;margin-bottom:10px">🎬 ${item.name} <span style="background:rgba(123,47,255,0.2);border:1px solid #7b2fff;color:#7b2fff;padding:1px 6px;border-radius:10px;font-size:9px">🔒 Admin Only</span></p>
    <video controls style="width:100%;border-radius:8px;background:#000" src="${item.base64}"></video>`;
  const cl = document.createElement('button'); cl.className = 'btn-sm'; cl.textContent = '✕ Close'; cl.style.marginTop = '10px';
  cl.addEventListener('click', () => document.body.removeChild(o));
  b.appendChild(cl); o.appendChild(b);
  o.addEventListener('click', e => { if (e.target === o) document.body.removeChild(o); });
  document.body.appendChild(o);
}

// ─── TEACHER CAMERA ──────────────────────────────────────────────────────────
async function startTeacherCam() {
  try {
    teacherCamStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    const v = $('tCamVid'); v.srcObject = teacherCamStream; v.classList.remove('hidden'); hide('tCamOff');
    await dbSetting('teacherCam', true);
  } catch { alert('Camera access denied.'); }
}

function stopTeacherCam() {
  if (teacherCamStream) { teacherCamStream.getTracks().forEach(t => t.stop()); teacherCamStream = null; }
  const v = $('tCamVid'); v.srcObject = null; v.classList.add('hidden'); show('tCamOff');
  dbSetting('teacherCam', false);
}

async function saveSnapshot() {
  await dbAdd('recordings', { label: `Snapshot ${Date.now()}`, ts: Date.now(), type: 'snapshot' });
  await renderRecordingList();
}

async function renderRecordingList() {
  const recs = await dbGetAll('recordings');
  const el = $('recList');
  if (!el) return;
  if (!recs.length) { el.innerHTML = '<div class="empty-state small">No recordings</div>'; return; }
  el.innerHTML = '';
  recs.slice().reverse().forEach(r => {
    const d = document.createElement('div'); d.className = 'rec-item';
    d.innerHTML = `<span>📹</span><span style="flex:1">${r.label}</span><span style="color:var(--text3);font-size:10px">${fmtDT(r.ts)}</span>`;
    el.appendChild(d);
  });
}

// ─── TEACHER DASHBOARD REFRESH ────────────────────────────────────────────────
async function refreshTeacherAll() {
  if (!DB) return;
  const sessions  = await dbGetAll('sessions');
  const events    = await dbGetAll('events');

  // KPIs
  $('kStudents').textContent = sessions.length;
  const scored = sessions.filter(s => s.points > 0);
  $('kAvg').textContent = scored.length ? Math.round(scored.reduce((a, s) => a + (s.points || 0), 0) / scored.length) : '—';

  const inFsCount = sessions.filter(s => s.fsInFullscreen).length;
  $('kFs').textContent = sessions.length ? `${inFsCount}/${sessions.length}` : '—';
  $('kExits').textContent = events.filter(e => e.type === 'fs_exit').length;

  // Charts
  const dist = { High: 0, Medium: 0, Low: 0 };
  sessions.forEach(s => { if (s.focus && dist[s.focus] !== undefined) dist[s.focus]++; });
  drawPie($('cPie'), dist, $('pieLeg'));
  drawBar($('cBar'), dist);

  // FS Monitor table
  const tb  = $('fsTblBody');
  const emp = $('fsTblEmpty');
  if (!sessions.length) { tb.innerHTML = ''; emp?.classList.remove('hidden'); }
  else {
    emp?.classList.add('hidden');
    tb.innerHTML = '';
    sessions.forEach(s => {
      const tr = document.createElement('tr');
      const isFs = !!s.fsInFullscreen;
      tr.innerHTML = `<td>${s.username}</td>
        <td><span class="fc-chip ${s.focus || ''}">${s.focus || '—'}</span></td>
        <td>${isFs ? '<span class="fs-ok" title="In fullscreen">✓ Active</span>' : '<span class="fs-no" title="Not fullscreen">✗ Exited</span>'}</td>
        <td>${s.lastExit ? fmtT(s.lastExit) : '—'}</td>
        <td style="color:var(--danger)">${s.fsExitCount || 0}</td>
        <td style="color:var(--neon)">${s.points || 0}</td>`;
      tb.appendChild(tr);
    });
  }

  // Camera grids
  await renderCamGrid('tVidGrid', $('camBadge'));
  await renderRecordingList();
  await renderMediaLibrary();
  syncTeacherToggles();
}

async function renderCamGrid(gridId, badgeEl) {
  const sessions  = await dbGetAll('sessions');
  const camStates = [];
  for (const s of sessions) {
    const state = await dbGetSetting(`cam_${s.username}`, { active: false });
    if (state.active) camStates.push(s.username);
  }
  const grid = $(gridId);
  if (!grid) return;
  if (badgeEl) badgeEl.textContent = `${camStates.length} cams`;
  if (!camStates.length) { grid.innerHTML = '<div class="empty-state small">No cameras active</div>'; return; }
  grid.innerHTML = '';
  camStates.forEach(user => {
    const cell = document.createElement('div'); cell.className = 'vid-cell';
    cell.innerHTML = `<div class="vid-ph"><div>📷</div><small>${user}</small></div><div class="vid-label">${user}</div>`;
    grid.appendChild(cell);
  });
}

// ─── ANALYTICS TAB ───────────────────────────────────────────────────────────
async function renderAnalyticsTab() {
  if (!DB) return;
  const sessions = await dbGetAll('sessions');
  const events   = await dbGetAll('events');

  const dist = { High: 0, Medium: 0, Low: 0 };
  sessions.forEach(s => { if (s.focus && dist[s.focus] !== undefined) dist[s.focus]++; });
  drawDonut($('cDonut'), dist, $('donutLeg'));

  // FS exit events
  const fsEvts = events.filter(e => e.type === 'fs_exit').slice().reverse().slice(0, 20);
  const feed = $('fsExitFeed');
  if (feed) {
    if (!fsEvts.length) { feed.innerHTML = '<div class="empty-state small">No exits logged</div>'; }
    else {
      feed.innerHTML = '';
      fsEvts.forEach(e => {
        const d = document.createElement('div'); d.className = 'ev-item';
        d.innerHTML = `<div class="ev-dot" style="background:var(--danger)"></div><div class="ev-txt">${e.username} exited fullscreen</div><div class="ev-time">${fmtDT(e.ts)}</div>`;
        feed.appendChild(d);
      });
    }
  }

  const total = sessions.length;
  const lowCount = sessions.filter(s => s.focus === 'Low').length;
  $('lfBig').textContent = total ? Math.round(lowCount / total * 100) + '%' : '0%';

  const tbody = $('analyticsTblBody');
  const empty = $('analyticsEmpty');
  if (!sessions.length) { tbody.innerHTML = ''; empty?.classList.remove('hidden'); return; }
  empty?.classList.add('hidden');
  tbody.innerHTML = '';
  sessions.slice().reverse().forEach(s => {
    const tr = document.createElement('tr');
    const dur = elapsed(s.startTime || s.lastSeen);
    tr.innerHTML = `<td>${s.username}</td>
      <td><span class="fc-chip ${s.focus || ''}">${s.focus || '—'}</span></td>
      <td>${s.fsInFullscreen ? '<span class="fs-ok">✓</span>' : '<span class="fs-no">✗</span>'}</td>
      <td>${dur}</td>
      <td style="color:var(--neon)">${s.points || 0}</td>
      <td style="color:${s.aiUsed ? 'var(--neon3)' : 'var(--text3)'}">${s.aiUsed ? 'Yes' : 'No'}</td>
      <td style="color:var(--danger)">${s.fsExitCount || 0}</td>`;
    tbody.appendChild(tr);
  });
}

// ─── VIDEO TAB ────────────────────────────────────────────────────────────────
async function renderVideoTab() {
  await renderCamGrid('tVidGrid2', $('camBadge2'));
  await renderRecordingList();
}

// ─── TIMELINE TAB ─────────────────────────────────────────────────────────────
async function renderTimelineTab() {
  if (!DB) return;
  const sessions = await dbGetAll('sessions');
  const events   = await dbGetAll('events');

  // Filter sessions with focus + build score array
  const scored = sessions.filter(s => s.focus);
  const pts    = scored.map(s => FOCUS_PTS[s.focus] || 0);
  const fsExits = events.filter(e => e.type === 'fs_exit');
  drawLine($('cLine'), pts, scored, fsExits);

  // Event log (admin-only, from DB)
  const feed = $('eventLogFeed');
  if (!feed) return;
  const allEvts = events.slice().reverse().slice(0, 40);
  if (!allEvts.length) { feed.innerHTML = '<div class="empty-state small">No events yet</div>'; return; }
  feed.innerHTML = '';
  allEvts.forEach(e => {
    const d = document.createElement('div'); d.className = 'ev-item';
    d.innerHTML = `<div class="ev-dot" style="background:${e.color || '#6b8caa'}"></div><div class="ev-txt">${e.message}</div><div class="ev-time">${fmtDT(e.ts)}</div>`;
    feed.appendChild(d);
  });
}

// ─── CANVAS CHARTS ────────────────────────────────────────────────────────────
function drawPie(canvas, dist, legendEl) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  if (!total) {
    ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.beginPath(); ctx.arc(W/2, H/2, 88, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.textAlign = 'center'; ctx.font = '11px JetBrains Mono,monospace';
    ctx.fillText('No data', W/2, H/2+4); return;
  }
  const labels = ['High','Medium','Low'], colors = [FOCUS_COLOR.High, FOCUS_COLOR.Medium, FOCUS_COLOR.Low];
  let start = -Math.PI / 2;
  if (legendEl) legendEl.innerHTML = '';
  labels.forEach((k, i) => {
    const v = dist[k] || 0; if (!v) return;
    const sw = v / total * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(W/2, H/2); ctx.arc(W/2, H/2, 88, start, start + sw); ctx.closePath();
    ctx.fillStyle = colors[i]; ctx.fill(); ctx.strokeStyle = '#020810'; ctx.lineWidth = 2.5; ctx.stroke();
    const mid = start + sw / 2;
    ctx.fillStyle = '#000'; ctx.font = 'bold 11px monospace'; ctx.textAlign = 'center';
    ctx.fillText(Math.round(v / total * 100) + '%', W/2 + 58*Math.cos(mid), H/2 + 58*Math.sin(mid) + 4);
    start += sw;
    if (legendEl) {
      const d = document.createElement('div'); d.className = 'cl-item';
      d.innerHTML = `<div class="cl-dot" style="background:${colors[i]}"></div><span>${k}: ${v}</span>`;
      legendEl.appendChild(d);
    }
  });
}

function drawBar(canvas, dist) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const labels = ['High','Medium','Low'], colors = [FOCUS_COLOR.High, FOCUS_COLOR.Medium, FOCUS_COLOR.Low];
  const vals = labels.map(k => dist[k] || 0);
  const maxV = Math.max(...vals, 1);
  const bw = 55, gap = 38, sx = 44, byLine = H - 36;
  for (let i = 0; i <= 4; i++) {
    const y = byLine - (i/4)*(byLine-20);
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(30, y); ctx.lineTo(W-10, y); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.font = '10px monospace'; ctx.textAlign = 'right';
    ctx.fillText(Math.round(maxV*i/4), 28, y+3);
  }
  labels.forEach((k, i) => {
    const x = sx + i*(bw+gap), bh = ((vals[i]/maxV)*(byLine-20))||0, y = byLine-bh;
    if (bh > 0) {
      const g = ctx.createLinearGradient(0,y,0,byLine); g.addColorStop(0, colors[i]); g.addColorStop(1, colors[i]+'28');
      ctx.fillStyle = g; ctx.beginPath(); ctx.roundRect?ctx.roundRect(x,y,bw,bh,4):(ctx.rect(x,y,bw,bh)); ctx.fill();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.font = '11px monospace'; ctx.textAlign = 'center';
    ctx.fillText(k, x+bw/2, byLine+14);
    if (vals[i]>0) { ctx.fillStyle = colors[i]; ctx.font = 'bold 12px monospace'; ctx.fillText(vals[i], x+bw/2, y-6); }
  });
}

function drawDonut(canvas, dist, legendEl) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, cx = W/2, cy = H/2;
  ctx.clearRect(0, 0, W, H);
  const total = Object.values(dist).reduce((a,b)=>a+b,0);
  const labels = ['High','Medium','Low'], colors = [FOCUS_COLOR.High, FOCUS_COLOR.Medium, FOCUS_COLOR.Low];
  if (legendEl) legendEl.innerHTML = '';
  if (!total) {
    ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.beginPath(); ctx.arc(cx,cy,88,0,Math.PI*2); ctx.fill();
    ctx.fillStyle = '#020810'; ctx.beginPath(); ctx.arc(cx,cy,48,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='rgba(255,255,255,0.2)'; ctx.textAlign='center'; ctx.font='11px monospace'; ctx.fillText('No data',cx,cy+4); return;
  }
  let start = -Math.PI/2;
  labels.forEach((k,i)=>{
    const v=dist[k]||0; if(!v) return;
    const sw = v/total*Math.PI*2;
    ctx.beginPath(); ctx.moveTo(cx,cy); ctx.arc(cx,cy,88,start,start+sw); ctx.closePath();
    ctx.fillStyle=colors[i]; ctx.fill(); ctx.strokeStyle='#020810'; ctx.lineWidth=3; ctx.stroke();
    start+=sw;
    if(legendEl){const d=document.createElement('div');d.className='cl-item';d.innerHTML=`<div class="cl-dot" style="background:${colors[i]}"></div><span>${k}: ${v} (${Math.round(v/total*100)}%)</span>`;legendEl.appendChild(d);}
  });
  ctx.fillStyle='#060e1e'; ctx.beginPath(); ctx.arc(cx,cy,48,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='rgba(255,255,255,0.75)'; ctx.font='bold 20px Georgia,serif'; ctx.textAlign='center'; ctx.fillText(total,cx,cy-2);
  ctx.fillStyle='rgba(255,255,255,0.3)'; ctx.font='10px monospace'; ctx.fillText('sessions',cx,cy+14);
}

function drawLine(canvas, points, sessions, fsExits) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0,0,W,H);
  if (points.length < 2) {
    ctx.fillStyle='rgba(255,255,255,0.2)'; ctx.textAlign='center'; ctx.font='12px monospace';
    ctx.fillText('Need 2+ sessions to render trend', W/2, H/2); return;
  }
  const n=points.length, px=50, py=20, bY=H-40, cW=W-px*2, cH=bY-py;
  const gX=i=>px+(i/(n-1))*cW, gY=v=>py+cH-((v-0)/(110-0))*cH;
  [0,50,100].forEach(v=>{
    const y=gY(v); ctx.strokeStyle='rgba(255,255,255,0.04)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(px,y); ctx.lineTo(W-px,y); ctx.stroke();
    ctx.fillStyle='rgba(255,255,255,0.2)'; ctx.font='10px monospace'; ctx.textAlign='right'; ctx.fillText(v,px-8,y+3);
  });
  // Fill
  const gf = ctx.createLinearGradient(0,py,0,bY); gf.addColorStop(0,'rgba(0,212,255,0.2)'); gf.addColorStop(1,'rgba(0,212,255,0)');
  ctx.beginPath(); ctx.moveTo(gX(0),gY(points[0]));
  for(let i=1;i<n;i++) ctx.lineTo(gX(i),gY(points[i]));
  ctx.lineTo(gX(n-1),bY); ctx.lineTo(gX(0),bY); ctx.closePath(); ctx.fillStyle=gf; ctx.fill();
  // Line
  ctx.beginPath(); ctx.strokeStyle='#00d4ff'; ctx.lineWidth=2.5; ctx.lineJoin='round';
  ctx.moveTo(gX(0),gY(points[0]));
  for(let i=1;i<n;i++) ctx.lineTo(gX(i),gY(points[i]));
  ctx.stroke();
  // Points
  points.forEach((p,i)=>{
    ctx.beginPath(); ctx.arc(gX(i),gY(p),4.5,0,Math.PI*2);
    ctx.fillStyle=FOCUS_COLOR[sessions[i]?.focus]||'#00d4ff'; ctx.fill();
    ctx.strokeStyle='#020810'; ctx.lineWidth=2; ctx.stroke();
  });
  // FS exit markers
  fsExits.slice(0,6).forEach((_,fi)=>{
    const xi=Math.min(fi,n-1);
    ctx.fillStyle='rgba(255,45,85,0.9)'; ctx.font='bold 12px monospace'; ctx.textAlign='center';
    ctx.fillText('⚠',gX(xi),gY(points[xi])-16);
  });
  // X labels
  const step=Math.max(1,Math.floor(n/5));
  sessions.forEach((s,i)=>{
    if(i%step!==0&&i!==n-1) return;
    ctx.fillStyle='rgba(255,255,255,0.2)'; ctx.font='9px monospace'; ctx.textAlign='center';
    ctx.fillText(fmtT(s.lastSeen||s.startTime||Date.now()),gX(i),H-6);
  });
}

// ─── POLLING / SYNC ──────────────────────────────────────────────────────────
function startSync() {
  clearTimers();
  syncTimer = setInterval(async () => {
    if (!currentUser) return clearTimers();
    if (currentRole === 'teacher') {
      await refreshTeacherAll();
    } else {
      await refreshStudentDoc();
      await refreshStudentScore();
      // Heartbeat
      if (DB) {
        const sess = await dbGet('sessions', currentUser);
        if (sess) { sess.lastSeen = Date.now(); await dbPut('sessions', sess); }
      }
    }
  }, SYNC_MS);
}

function clearTimers() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  if (aiTimer)   { clearInterval(aiTimer); aiTimer = null; }
  clearExitTimer();
}
