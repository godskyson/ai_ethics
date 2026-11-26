// 접속·이탈·붙여넣기 기록 → presence/{sid}
// 교사 대시보드가 이 값을 실시간으로 본다.
// - state: 'focused' | 'away' (로그인한 동안 항상 갱신)
// - awayCount, awayMs, lastAwayAt, pasteCount: 평가가 진행 중이고 제출 전일 때만 누적한다 (isCounting)
// 카운터는 increment()로 올려서 값을 먼저 읽지 않아도 된다.
import { db, ref, update, serverTimestamp, increment, isPermissionDenied } from './firebase.js';

const HEARTBEAT_MS = 30_000;
const MERGE_MS = 300; // blur와 visibilitychange가 함께 일어나도 한 번만 센다

let sid = null;
let isCounting = () => false;
let onDenied = () => {};
let away = false;
let awayStart = 0;
let awayCounted = false;
let lastChange = 0;
let heartbeat = null;

function write(patch) {
  if (!sid) return;
  update(ref(db, `presence/${sid}`), { ...patch, lastSeen: serverTimestamp() }).catch(e => {
    if (isPermissionDenied(e)) onDenied();
    else console.error(e);
  });
}

function goAway() {
  if (!sid || away) return;
  const now = Date.now();
  if (now - lastChange < MERGE_MS) return;
  away = true;
  lastChange = now;
  awayStart = now;
  awayCounted = isCounting();
  write(awayCounted
    ? { state: 'away', awayCount: increment(1), lastAwayAt: serverTimestamp() }
    : { state: 'away' });
}

function comeBack() {
  if (!sid || !away) return;
  if (document.visibilityState === 'hidden' || !document.hasFocus()) return; // 아직 돌아오지 않았다
  away = false;
  lastChange = Date.now();
  const patch = { state: 'focused' };
  if (awayCounted) patch.awayMs = increment(Date.now() - awayStart);
  write(patch);
}

function onVisibility() {
  if (document.visibilityState === 'hidden') goAway(); else comeBack();
}

function onPaste(e) {
  if (!sid || !isCounting()) return;
  // 평가 화면의 입력칸에 붙여넣은 경우만 센다 (로그인 칸 제외)
  if (!e.target.closest || !e.target.closest('[data-screen="exam"]')) return;
  write({ pasteCount: increment(1), lastPasteAt: serverTimestamp() });
}

// 지금 상태를 바로 다시 보낸다. 교사가 '새 평가 준비'로 접속 기록을 지운 직후에도 곧바로 표시되게 한다.
export function ping() {
  write({ online: true, state: away ? 'away' : 'focused' });
}

export function start(studentId, opts = {}) {
  stop();
  sid = studentId;
  isCounting = opts.isCounting || (() => false);
  onDenied = opts.onDenied || (() => {});
  away = false;
  lastChange = 0;
  const hidden = document.visibilityState === 'hidden' || !document.hasFocus();
  write({ state: hidden ? 'away' : 'focused' });
  if (hidden) { away = true; awayStart = Date.now(); awayCounted = false; }

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('blur', goAway);
  window.addEventListener('focus', comeBack);
  window.addEventListener('pagehide', goAway);
  document.addEventListener('paste', onPaste, true);
  heartbeat = setInterval(() => write({}), HEARTBEAT_MS);
}

export function stop() {
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('blur', goAway);
  window.removeEventListener('focus', comeBack);
  window.removeEventListener('pagehide', goAway);
  document.removeEventListener('paste', onPaste, true);
  clearInterval(heartbeat);
  heartbeat = null;
  sid = null;
}
