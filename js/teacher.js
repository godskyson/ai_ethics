// 교사 화면: 로그인 → 평가 제어 + 실시간 대시보드 + 학생 상세 + 비밀번호 초기화
import {
  db, auth, ref, get, set, update, onValue, serverTimestamp,
  signInWithEmailAndPassword, signOut, onAuthStateChanged, onConnection, serverNow,
} from './firebase.js';
import { TEACHER_EMAIL } from './firebase-config.js';
import {
  INITIAL_PIN, classOf, hashPin, makeExamId, fmtTime, fmtDuration, showError, toast, confirmDialog,
} from './common.js';
import { STEP_NAMES, makeRow, stepLabel, openDetail, refreshDetail, isDetailOpen } from './detail.js';
import * as roster from './roster.js';
import * as results from './results.js';
import * as accessLog from './accesslog.js';

const $ = id => document.getElementById(id);

// ----- 데이터 -----
const db$ = { exam: {}, roster: {}, progress: {}, presence: {} };
const unsubs = [];

// ----- 연결 상태 -----
onConnection(connected => {
  const el = $('netState');
  el.textContent = connected ? '' : '연결 끊김 — 다시 연결하는 중';
  el.classList.toggle('offline', !connected);
});

// ----- 로그인 -----
onAuthStateChanged(auth, user => {
  const isTeacher = user && !user.isAnonymous && user.email === TEACHER_EMAIL;
  if (user && !isTeacher) {
    // 학생(익명) 세션이나 다른 계정이면 교사 화면을 쓸 수 없다
    if (!user.isAnonymous) signOut(auth);
  }
  $('loginView').hidden = !!isTeacher;
  $('appView').hidden = !isTeacher;
  if (isTeacher) { startDashboard(); accessLog.record(); }
  else { stopDashboard(); $('email').focus(); }
});

$('accessLogBtn').addEventListener('click', () => accessLog.open());

$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('loginMsg');
  const email = $('email').value.trim();
  const password = $('password').value;
  if (!email || !password) return showError(msg, '이메일과 비밀번호를 입력해 주세요.');
  if (email !== TEACHER_EMAIL) return showError(msg, '교사 계정 이메일이 아니에요.');
  $('loginBtn').disabled = true;
  msg.textContent = '';
  try {
    await signInWithEmailAndPassword(auth, email, password);
    $('password').value = '';
  } catch (err) {
    console.error(err);
    showError(msg, /invalid|wrong|user-not-found/i.test(err.code || '')
      ? '이메일 또는 비밀번호가 맞지 않아요.'
      : '로그인하지 못했어요. 잠시 후 다시 시도해 주세요.');
  } finally {
    $('loginBtn').disabled = false;
  }
});

$('logoutBtn').addEventListener('click', () => { accessLog.forget(); signOut(auth); });

// ----- 구독 -----
let ticker = null;

function startDashboard() {
  stopDashboard();
  for (const key of ['exam', 'roster', 'progress', 'presence']) {
    unsubs.push(onValue(ref(db, key), snap => {
      db$[key] = snap.val() || {};
      render();
    }, err => {
      console.error(err);
      toast(`${key} 데이터를 읽지 못했어요. 보안 규칙의 교사 이메일을 확인해 주세요.`, 5000);
    }));
  }
  ticker = setInterval(render, 5000); // 경과 시간·응답 없음 표시 갱신
}

function stopDashboard() {
  while (unsubs.length) unsubs.pop()();
  clearInterval(ticker);
  results.stop();
}

// ----- 학생 한 명의 상태 계산 -----
const clsOf = sid => (db$.roster[sid] && db$.roster[sid].classId) || classOf(sid);
const sortClass = (a, b) => a.localeCompare(b, 'ko', { numeric: true });

function studentRows() {
  const now = serverNow();
  return Object.keys(db$.roster).sort().map(sid =>
    makeRow(sid, clsOf(sid), db$.progress[sid], db$.presence[sid], now));
}

// ----- 학급 -----
// 평가 상태는 학급마다 따로 있다: exam/classes/{학급} = { status, examId, startedAt, endedAt }
const STATUS_TEXT = { ready: '대기', running: '진행 중', ended: '종료' };
const CLASS_KEY = 'ai_ethics.teacher.class';
let selClass = '';
try { selClass = localStorage.getItem(CLASS_KEY) || ''; } catch { /* 저장소를 못 쓰면 전체 보기 */ }

function classList() { return [...new Set(Object.keys(db$.roster).map(clsOf))].sort(sortClass); }
function classState(cls) { return (db$.exam.classes && db$.exam.classes[cls]) || { status: 'ready' }; }

function selectClass(cls) {
  selClass = cls;
  try { localStorage.setItem(CLASS_KEY, cls); } catch { /* 무시 */ }
  render();
}

// ----- 렌더링 -----
function render() {
  renderClassBar();
  const all = studentRows();
  const rows = selClass ? all.filter(r => r.cls === selClass) : all;
  renderSummary(rows);
  renderGrid(rows, all.length);
  if (isDetailOpen()) refreshDetail(); // 열려 있는 상세 창도 실시간으로 갱신
  roster.render(db$.roster, db$.presence);
}

function renderClassBar() {
  const classes = classList();
  if (selClass && !classes.includes(selClass)) selClass = '';

  // 학급 선택 상자 (명단이 바뀔 때만 다시 만든다)
  const sel = $('classSel');
  const key = classes.join('|');
  if (sel.dataset.key !== key) {
    sel.innerHTML = '<option value="">전체 보기</option>' + classes.map(c => `<option value="${c}">${c}반</option>`).join('');
    sel.dataset.key = key;
  }
  sel.value = selClass;

  // 학급별 상태 칩: 진행 중이거나 종료된 학급이 한눈에 보이게
  $('classChips').innerHTML = classes.length > 1 ? classes.map(c => {
    const st = classState(c).status || 'ready';
    return `<button type="button" class="cchip ${st} ${c === selClass ? 'on' : ''}" data-cls="${c}"><b>${c}반</b>${STATUS_TEXT[st] || st}</button>`;
  }).join('') : '';

  const badge = $('statusBadge');
  if (!selClass) {
    badge.hidden = true;
    const running = classes.filter(c => classState(c).status === 'running');
    $('examMeta').textContent = running.length
      ? `진행 중: ${running.map(c => c + '반').join(', ')} · 평가를 시작·종료하려면 학급을 고르세요`
      : '평가를 시작하려면 학급을 고르세요';
    for (const id of ['startBtn', 'endBtn', 'resetExamBtn']) $(id).disabled = true;
    return;
  }
  const ex = classState(selClass);
  const status = ex.status || 'ready';
  badge.hidden = false;
  badge.textContent = STATUS_TEXT[status] || status;
  badge.className = 'badge ' + ({ ready: '', running: 'accent', ended: 'ink' }[status] || '');
  let meta = ex.examId ? `회차 ${ex.examId}` : '';
  if (status === 'running' && ex.startedAt) meta += ` · 경과 ${fmtDuration(serverNow() - ex.startedAt)}`;
  if (status === 'ended' && ex.endedAt) meta += ` · ${fmtTime(ex.endedAt)} 종료`;
  $('examMeta').textContent = meta;
  $('startBtn').disabled = status !== 'ready';
  $('endBtn').disabled = status !== 'running';
  $('resetExamBtn').disabled = status !== 'ended';
}

$('classSel').addEventListener('change', e => selectClass(e.target.value));
$('classChips').addEventListener('click', e => {
  const b = e.target.closest('[data-cls]');
  if (b) selectClass(b.dataset.cls);
});

function renderSummary(rows) {
  const total = rows.length;
  const online = rows.filter(r => r.online).length;
  const away = rows.filter(r => r.away).length;
  const submitted = rows.filter(r => r.submitted).length;
  const editing = rows.filter(r => r.editing).length;
  const dist = [0, 0, 0, 0, 0, 0, 0];
  rows.forEach(r => dist[r.submitted ? 6 : Math.min(r.step, 5)]++);
  const bar = dist.map((n, i) => n
    ? `<span class="s${i}" style="flex:${n}" title="${STEP_NAMES[i]} ${n}명">${n}</span>` : '').join('');
  const legend = STEP_NAMES.map((n, i) => `<span><i class="s${i}"></i>${i === 0 ? '시작 전' : n}</span>`).join('');
  $('summary').innerHTML = `
    <div class="stat"><div class="k">전체</div><div class="v">${total}</div></div>
    <div class="stat"><div class="k">접속 중</div><div class="v">${online}</div></div>
    <div class="stat ${away ? 'alert' : ''}"><div class="k">지금 이탈 중</div><div class="v">${away}</div></div>
    <div class="stat"><div class="k">제출</div><div class="v">${submitted}<span class="small muted"> / ${total}</span></div></div>
    <div class="stat"><div class="k">수정 중</div><div class="v">${editing}</div></div>
    <div class="stat wide"><div class="k">단계별 인원</div><div class="dist">${bar || '<span style="flex:1">-</span>'}</div>
      <div class="dist-legend">${legend}</div></div>`;
}

function renderGrid(classRows, totalCount) {
  const sort = $('sortBy').value;
  let rows = [...classRows];
  if ($('awayOnly').checked) rows = rows.filter(r => r.away);
  if (sort === 'step') rows.sort((a, b) => (a.submitted ? 7 : a.step) - (b.submitted ? 7 : b.step) || a.sid.localeCompare(b.sid));
  if (sort === 'away') rows.sort((a, b) => b.awayCount - a.awayCount || b.awayMs - a.awayMs || a.sid.localeCompare(b.sid));

  $('emptyNote').hidden = totalCount > 0;
  $('shownCount').textContent = totalCount ? `${selClass ? selClass + '반 · ' : ''}${rows.length}명 표시` : '';
  $('grid').innerHTML = rows.map(r => {
    const state = !r.online ? 'off' : r.away ? 'away' : r.stale ? 'stale' : r.submitted ? 'done' : '';
    const conn = !r.online ? '<span class="conn"><i></i>오프라인</span>'
      : r.away ? '<span class="conn away"><i></i>이탈 중</span>'
      : r.stale ? '<span class="conn on"><i></i>응답 없음</span>'
      : '<span class="conn on"><i></i>집중</span>';
    const filled = r.submitted ? 6 : r.step;
    const steps = Array.from({ length: 6 }, (_, i) => `<i class="${i < filled ? 'on' : ''}"></i>`).join('');
    const tag = r.submitted ? '<span class="badge ok">✓ 제출</span>' : r.editing ? '<span class="badge warn">수정 중</span>' : '';
    const seen = r.pr && r.pr.lastSeen ? `마지막 신호 ${fmtTime(r.pr.lastSeen)}` : '접속 기록 없음';
    const lastAway = r.pr && r.pr.lastAwayAt ? ` · 마지막 이탈 ${fmtTime(r.pr.lastAwayAt)}` : '';
    return `<article class="card ${state}" data-sid="${r.sid}">
      <div class="card-top"><span><span class="sid">${r.sid}</span><span class="cls">${r.cls}반</span></span>${conn}</div>
      <div class="card-body">
        <div class="step-label"><span>${stepLabel(r)}</span>${tag}</div>
        <div class="steps ${r.submitted ? 'done' : ''}" aria-hidden="true">${steps}</div>
        <div class="metrics">
          <span class="${r.awayCount ? 'hot' : ''}">이탈<b>${r.awayCount}회</b></span>
          <span>이탈 시간<b>${fmtDuration(r.awayMs)}</b></span>
          <span class="${r.pasteCount ? 'hot' : ''}">붙여넣기<b>${r.pasteCount}회</b></span>
        </div>
        <div class="seen">${seen}${lastAway}</div>
      </div>
      <div class="card-foot">
        <button type="button" data-act="detail">상세</button>
        <button type="button" data-act="reset">비밀번호 초기화</button>
      </div>
    </article>`;
  }).join('');
}

for (const id of ['sortBy', 'awayOnly']) $(id).addEventListener('change', render);

// ----- 카드 버튼 -----
$('grid').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const sid = btn.closest('[data-sid]').dataset.sid;
  if (btn.dataset.act === 'detail') openLiveDetail(sid);
  if (btn.dataset.act === 'reset') resetPin(sid);
});

async function resetPin(sid) {
  const ok = await confirmDialog({
    title: `${sid} 비밀번호 초기화`,
    body: `비밀번호를 ${INITIAL_PIN}으로 되돌려요.\n학생이 로그인해 있었다면 자동으로 로그아웃되고, ${INITIAL_PIN}으로 다시 로그인한 뒤 새 비밀번호를 정해야 해요.\n작성 중인 답안은 지워지지 않아요.`,
    ok: '초기화',
  });
  if (!ok) return;
  try {
    // 학생의 기존 로그인은 무효가 되어 학생 쪽에서 오프라인을 기록할 수 없으므로, 여기서 함께 오프라인으로 표시한다
    const patch = { [`pins/${sid}`]: { hash: await hashPin(sid, INITIAL_PIN), mustChange: true, updatedAt: serverTimestamp() } };
    if (db$.presence[sid]) patch[`presence/${sid}/online`] = false;
    await update(ref(db), patch);
    toast(`${sid} 비밀번호를 ${INITIAL_PIN}으로 초기화했어요.`);
  } catch (err) {
    console.error(err);
    toast('초기화하지 못했어요.');
  }
}

// ----- 학생 상세 (실시간) -----
function openLiveDetail(sid) {
  openDetail(() => studentRows().find(x => x.sid === sid), '실시간');
}

// ----- 평가 제어 (선택한 학급만) -----
const sidsOfClass = cls => Object.keys(db$.roster).filter(sid => clsOf(sid) === cls);

$('startBtn').addEventListener('click', async () => {
  const cls = selClass;
  if (!cls) return;
  const ok = await confirmDialog({
    title: `${cls}반 평가를 시작할까요?`,
    body: `${cls}반 학생 ${sidsOfClass(cls).length}명의 화면이 대기 화면에서 평가 화면으로 바로 바뀌어요.\n다른 반 학생은 계속 대기 화면에 있어요.`,
    ok: '평가 시작',
  });
  if (!ok) return;
  try {
    await update(ref(db, 'exam'), {
      [`classes/${cls}`]: { status: 'running', examId: makeExamId(new Date(serverNow())), startedAt: serverTimestamp() },
      // 학급별로 바꾸기 전에 쓰던 전체 상태 값은 지운다
      status: null, examId: null, startedAt: null, endedAt: null,
    });
    toast(`${cls}반 평가를 시작했어요.`);
  } catch (err) { console.error(err); toast('시작하지 못했어요.'); }
});

$('endBtn').addEventListener('click', async () => {
  const cls = selClass;
  if (!cls) return;
  const notSubmitted = studentRows().filter(r => r.cls === cls && !r.submitted).length;
  const ok = await confirmDialog({
    title: `${cls}반 평가를 종료할까요?`,
    body: `${cls}반 학생들은 더 이상 입력할 수 없어요.${notSubmitted ? `\n아직 제출하지 않은 학생이 ${notSubmitted}명 있어요. 이 학생들은 지금까지 저장된 내용이 결과로 남아요.` : ''}`,
    ok: '평가 종료', danger: true,
  });
  if (!ok) return;
  $('endBtn').disabled = true;
  try {
    // 1) 종료 시점의 이 학급 학생 상태를 결과로 저장 → 2) 상태를 종료로 바꾼다 (1이 실패하면 2를 하지 않는다)
    const [ex, roster, progress, presence] = await Promise.all(
      [`exam/classes/${cls}`, 'roster', 'progress', 'presence'].map(k => get(ref(db, k)).then(s => s.val() || {})));
    const examId = ex.examId || makeExamId(new Date(serverNow()));
    // 결과 ID = 학급_회차. 같은 ID의 결과가 이미 있으면 덮어쓰지 않도록 뒤에 번호를 붙인다
    const base = `${cls}_${examId}`;
    let resultId = base;
    for (let n = 2; (await get(ref(db, `results/${resultId}/meta`))).exists(); n++) resultId = `${base}-${n}`;
    const students = {};
    for (const sid of Object.keys(roster)) {
      if ((roster[sid].classId || classOf(sid)) !== cls) continue;
      students[sid] = { classId: cls, progress: progress[sid] || null, presence: presence[sid] || null };
    }
    await set(ref(db, `results/${resultId}`), {
      meta: { classId: cls, examId, startedAt: ex.startedAt || null, endedAt: serverTimestamp(), count: Object.keys(students).length },
      students,
    });
    await update(ref(db, `exam/classes/${cls}`), { status: 'ended', examId, resultId, endedAt: serverTimestamp() });
    toast(`${cls}반 평가를 종료하고 결과를 저장했어요.`, 4000);
  } catch (err) {
    console.error(err);
    toast('종료하지 못했어요. 결과 저장에 실패해서 평가는 계속 진행 중이에요.', 5000);
  } finally {
    renderClassBar();
  }
});

$('resetExamBtn').addEventListener('click', async () => {
  const cls = selClass;
  if (!cls) return;
  const ok = await confirmDialog({
    title: `${cls}반 평가를 다시 준비할까요?`,
    body: `${cls}반 학생들의 진행 데이터와 접속 기록을 지우고 대기 상태로 돌아가요.\n다른 반, 명단, 비밀번호, 저장된 결과는 그대로 남아요.`,
    ok: '진행 데이터 지우기', danger: true,
  });
  if (!ok) return;
  try {
    const patch = { [`exam/classes/${cls}`]: { status: 'ready' } };
    for (const sid of sidsOfClass(cls)) { patch[`progress/${sid}`] = null; patch[`presence/${sid}`] = null; }
    await update(ref(db), patch);
    toast(`${cls}반을 대기 상태로 되돌렸어요. 평가 시작을 누르면 시작돼요.`);
  } catch (err) { console.error(err); toast('준비하지 못했어요.'); }
});

// ----- 탭 -----
const tabs = [['tabDash', 'dashView'], ['tabRoster', 'rosterView'], ['tabResults', 'resultsView']];
for (const [tabId, viewId] of tabs) {
  $(tabId).addEventListener('click', () => {
    for (const [t, v] of tabs) {
      $(t).setAttribute('aria-selected', String(t === tabId));
      $(v).hidden = v !== viewId;
    }
    if (viewId === 'resultsView') results.start(); // 결과는 탭을 열 때 처음 불러온다
  });
}
