// 학생 화면: 로그인 → (비밀번호 변경) → 대기 / 평가 / 종료
import {
  db, auth, ref, get, set, update, remove, onValue, serverTimestamp, onDisconnect,
  signInAnonymously, onAuthStateChanged, onConnection, isPermissionDenied,
} from './firebase.js';
import { INITIAL_PIN, isValidSid, isValidPin, classOf, hashPin, showError, toast } from './common.js';
import * as exam from './exam.js';
import * as presence from './presence.js';

const $ = id => document.getElementById(id);

// ----- 상태 -----
const state = {
  uid: null,
  sid: null,           // 로그인한 학번 (null이면 로그인 전)
  mustChange: false,
  examStatus: null,    // 'ready' | 'running' | 'ended'
  loaded: { pin: false, exam: false }, // 로그인 뒤 첫 값을 받았는지
};
const unsubs = [];     // 로그인한 동안만 유지하는 구독

// ----- 화면 전환 -----
const screens = [...document.querySelectorAll('[data-screen]')];
let currentScreen = 'loading';
let pending = null; // 진행 중인 전환 타이머. 전환이 겹치면 이전 것을 취소한다.

function show(name) {
  if (name === currentScreen) return;
  clearTimeout(pending);
  const next = screens.find(s => s.dataset.screen === name);
  const visible = screens.filter(s => s !== next && s.classList.contains('show'));
  // 이미 나가는 중이던 화면은 바로 정리한다
  screens.forEach(s => { if (s !== next) s.classList.remove('leave'); });
  currentScreen = name;
  const enter = () => {
    pending = null;
    screens.forEach(s => { if (s !== next) s.classList.remove('show', 'leave'); });
    next.classList.add('show');
    const focusEl = next.querySelector('input:not([disabled])');
    if (focusEl) focusEl.focus({ preventScroll: true });
  };
  if (!visible.length) return enter();
  visible.forEach(s => { s.classList.remove('show'); s.classList.add('leave'); });
  pending = setTimeout(enter, 180);
}

// 현재 상태에 맞는 화면을 고른다
function route() {
  if (!state.uid) return show('loading');
  if (!state.sid) return show('login');
  if (!state.loaded.pin || !state.loaded.exam) return show('loading'); // 필요한 값이 다 오기 전에는 판단하지 않는다
  if (state.mustChange) return show('changePin');
  if (state.examStatus === 'running') {
    if (!exam.isLoaded()) {
      show('loading');
      exam.load(state.sid).then(route).catch(e => {
        console.error(e);
        toast('평가 내용을 불러오지 못했어요. 새로고침해 주세요.', 4000);
      });
      return;
    }
    return show(exam.isSubmitted() ? 'done' : 'exam');
  }
  if (state.examStatus === 'ended') return show('ended');
  return show('waiting');
}

exam.init({ onChange: () => route() });

function renderWho() {
  const on = !!state.sid;
  $('who').hidden = !on;
  if (on) {
    $('whoSid').textContent = `${state.sid} · ${classOf(state.sid)}반`;
    $('waitWho').textContent = `${state.sid} (${classOf(state.sid)}반)으로 로그인했어요.`;
  }
}

// ----- 연결 상태 표시 -----
onConnection(connected => {
  const el = $('netState');
  el.textContent = connected ? '' : '연결 끊김 — 다시 연결하는 중';
  el.classList.toggle('offline', !connected);
});

// ----- 익명 로그인 -----
onAuthStateChanged(auth, async user => {
  if (!user) {
    try { await signInAnonymously(auth); }
    catch (e) {
      console.error(e);
      show('login');
      showError($('loginMsg'), '서버에 연결하지 못했어요. 인터넷 연결을 확인하고 새로고침해 주세요.');
    }
    return;
  }
  state.uid = user.uid;
  await restoreSession();
  route();
});

// 새로고침했을 때: 이 기기에 남은 로그인(claim)이 아직 유효한지 확인한다
async function restoreSession() {
  let claim = null;
  try { claim = (await get(ref(db, `claims/${state.uid}`))).val(); } catch (e) { console.error(e); }
  if (!claim || !claim.sid) return;
  // presence 쓰기는 claim의 해시가 현재 비밀번호와 같을 때만 허용된다 → 유효성 검사로 쓴다
  try {
    await update(ref(db, `presence/${claim.sid}`), { online: true, lastSeen: serverTimestamp() });
  } catch (e) {
    if (isPermissionDenied(e)) {
      await remove(ref(db, `claims/${state.uid}`)).catch(() => {});
      toast('비밀번호가 바뀌어서 다시 로그인해야 해요.');
      return;
    }
    console.error(e);
  }
  await startSession(claim.sid);
}

// ----- 로그인 -----
let fails = 0;
let lockUntil = 0;

$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('loginMsg');
  const sid = $('sid').value.trim();
  const pin = $('pin').value.trim();

  if (Date.now() < lockUntil) {
    return showError(msg, `잠시 후 다시 시도해 주세요. (${Math.ceil((lockUntil - Date.now()) / 1000)}초)`);
  }
  if (!isValidSid(sid)) { $('sid').focus(); return showError(msg, '학번 5자리를 확인해 주세요. 예: 10101'); }
  if (!isValidPin(pin)) { $('pin').focus(); return showError(msg, '비밀번호는 숫자 4자리예요.'); }
  if (!state.uid) return showError(msg, '아직 서버에 연결 중이에요. 잠시 후 다시 눌러 주세요.');

  const btn = $('loginBtn');
  btn.disabled = true;
  msg.textContent = '';
  try {
    const hash = await hashPin(sid, pin);
    // 보안 규칙이 이 해시와 저장된 비밀번호 해시를 비교한다. 다르면 거부된다.
    await set(ref(db, `claims/${state.uid}`), { sid, hash, at: serverTimestamp() });
    fails = 0;
    $('pin').value = '';
    await startSession(sid);
    route();
  } catch (err) {
    if (isPermissionDenied(err)) {
      fails++;
      if (fails >= 5) { lockUntil = Date.now() + 30_000; fails = 0; }
      $('pin').value = '';
      $('pin').focus();
      showError(msg, '학번 또는 비밀번호가 맞지 않아요.');
    } else {
      console.error(err);
      showError(msg, '로그인하지 못했어요. 인터넷 연결을 확인해 주세요.');
    }
  } finally {
    btn.disabled = false;
  }
});

// 로그인에 성공한 뒤: 필요한 값을 구독하고 접속 상태를 기록한다
async function startSession(sid) {
  stopSession();
  state.sid = sid;
  state.loaded = { pin: false, exam: false };
  renderWho();

  // 비밀번호 변경이 필요한지. 교사가 초기화하면 true로 바뀐다.
  let first = true;
  unsubs.push(onValue(ref(db, `pins/${sid}/mustChange`), snap => {
    const v = snap.val() === true;
    if (!first && v && !state.mustChange) {
      // 로그인한 상태에서 교사가 비밀번호를 초기화한 경우 → 기존 로그인은 무효가 된다
      forceLogout('선생님이 비밀번호를 초기화했어요. 0000으로 다시 로그인해 주세요.');
      return;
    }
    first = false;
    state.mustChange = v;
    state.loaded.pin = true;
    route();
  }, err => {
    // 읽기 권한이 사라졌다 = 교사가 이 학번을 명단에서 삭제했다 (로그인 정보도 함께 지워짐)
    console.error(err);
    if (state.sid === sid) forceLogout('이 학번으로 더 이상 로그인할 수 없어요. 선생님께 확인해 주세요.');
  }));

  // 평가 상태
  // 평가는 학급마다 따로 시작·종료된다 → 내 학급의 상태만 본다
  unsubs.push(onValue(ref(db, `exam/classes/${classOf(sid)}/status`), snap => {
    const prev = state.examStatus;
    state.examStatus = snap.val() || 'ready';
    state.loaded.exam = true;
    if (prev === 'running' && state.examStatus !== 'running') exam.flush(); // 종료 직전 입력을 마지막으로 저장 시도
    if (state.examStatus === 'ready') exam.unload(); // 새 평가 준비: 진행 데이터가 지워지므로 다음에 새로 불러온다
    if (prev && prev !== state.examStatus) presence.ping(); // 교사가 접속 기록을 지웠을 수 있으므로 바로 다시 알린다
    route();
  }, err => console.error(err)));

  // 접속 상태
  unsubs.push(onConnection(async connected => {
    if (!connected || !state.sid) return;
    const pRef = ref(db, `presence/${sid}`);
    try {
      await onDisconnect(pRef).update({ online: false, lastSeen: serverTimestamp() });
      await update(pRef, { online: true, lastSeen: serverTimestamp() });
    } catch (e) {
      if (isPermissionDenied(e)) forceLogout('다시 로그인해 주세요.');
      else console.error(e);
    }
  }));

  // 화면 이탈·붙여넣기 기록. 횟수는 평가 진행 중이고 아직 제출하지 않았을 때만 센다.
  // 제출 완료한 학생도 '이탈 중' 상태는 교사에게 보이지만 횟수·시간은 늘지 않는다 (수정하기를 누르면 다시 센다).
  presence.start(sid, {
    isCounting: () => state.examStatus === 'running' && !(exam.isLoaded() && exam.isSubmitted()),
    onDenied: () => forceLogout('다시 로그인해 주세요.'),
  });
}

function stopSession() {
  presence.stop();
  while (unsubs.length) unsubs.pop()();
}

async function forceLogout(message) {
  await logout();
  if (message) toast(message, 4000);
}

async function logout() {
  const sid = state.sid;
  exam.unload();
  stopSession();
  if (sid) {
    const pRef = ref(db, `presence/${sid}`);
    await update(pRef, { online: false, lastSeen: serverTimestamp() }).catch(() => {});
    await onDisconnect(pRef).cancel().catch(() => {});
  }
  if (state.uid) await remove(ref(db, `claims/${state.uid}`)).catch(() => {});
  state.sid = null;
  state.mustChange = false;
  state.examStatus = null;
  renderWho();
  route();
}

$('logoutBtn').addEventListener('click', () => logout());

// ----- 비밀번호 변경 -----
$('pinForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('pinMsg');
  const p1 = $('newPin').value.trim();
  const p2 = $('newPin2').value.trim();

  if (!isValidPin(p1)) { $('newPin').focus(); return showError(msg, '새 비밀번호는 숫자 4자리여야 해요.'); }
  if (p1 === INITIAL_PIN) { $('newPin').focus(); return showError(msg, '0000은 쓸 수 없어요. 다른 숫자로 정해 주세요.'); }
  if (p1 !== p2) { $('newPin2').focus(); return showError(msg, '두 비밀번호가 서로 달라요. 다시 확인해 주세요.'); }

  const btn = $('pinBtn');
  btn.disabled = true;
  msg.textContent = '';
  try {
    const hash = await hashPin(state.sid, p1);
    // 비밀번호와 이 기기의 로그인 정보를 한 번에 바꾼다 (다른 기기의 로그인은 무효가 된다)
    await update(ref(db), {
      [`pins/${state.sid}`]: { hash, mustChange: false, updatedAt: serverTimestamp() },
      [`claims/${state.uid}`]: { sid: state.sid, hash, at: serverTimestamp() },
    });
    $('newPin').value = '';
    $('newPin2').value = '';
    state.mustChange = false;
    toast('비밀번호를 바꿨어요. 꼭 기억해 두세요!', 3500);
    route();
  } catch (err) {
    console.error(err);
    if (isPermissionDenied(err)) {
      forceLogout('로그인 정보가 바뀌었어요. 다시 로그인해 주세요.');
    } else {
      showError(msg, '비밀번호를 바꾸지 못했어요. 인터넷 연결을 확인해 주세요.');
    }
  } finally {
    btn.disabled = false;
  }
});

// 숫자만 입력되게 한다
for (const id of ['sid', 'pin', 'newPin', 'newPin2']) {
  $(id).addEventListener('input', e => {
    const v = e.target.value.replace(/\D/g, '');
    if (v !== e.target.value) e.target.value = v;
  });
}
