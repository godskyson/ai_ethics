// 명단 관리: 반 단위 범위 추가, 붙여넣기 추가, 한 명 추가, 삭제
// 학생을 추가할 때 roster/{sid}와 pins/{sid}(0000)를 한 번의 update로 쓴다.
import { db, ref, get, update, serverTimestamp } from './firebase.js';
import { INITIAL_PIN, isValidSid, classOf, hashPin, showError, showOk, toast, confirmDialog, escapeHtml } from './common.js';

const $ = id => document.getElementById(id);
let current = {};   // 등록된 명단 { sid: {classId} }
let presence = {};
let renderedKey = '';

const sortClass = (a, b) => a.localeCompare(b, 'ko', { numeric: true });

// ----- 추가 -----
async function addStudents(sids) {
  const fresh = [...new Set(sids)].filter(s => isValidSid(s) && !current[s]);
  if (!fresh.length) return 0;
  const patch = {};
  for (const sid of fresh) {
    patch[`roster/${sid}`] = { classId: classOf(sid), addedAt: serverTimestamp() };
    patch[`pins/${sid}`] = { hash: await hashPin(sid, INITIAL_PIN), mustChange: true, updatedAt: serverTimestamp() };
  }
  await update(ref(db), patch);
  return fresh.length;
}

async function runAdd(sids, btn, after) {
  const msg = $('rosterMsg');
  const dup = sids.filter(s => current[s]).length;
  btn.disabled = true;
  try {
    const n = await addStudents(sids);
    if (!n) return showError(msg, dup ? '모두 이미 등록된 학번이에요.' : '추가할 학번이 없어요.');
    showOk(msg, `${n}명을 추가했어요.${dup ? ` (이미 등록된 ${dup}명은 건너뜀)` : ''} 비밀번호는 ${INITIAL_PIN}이에요.`);
    after && after();
  } catch (e) {
    console.error(e);
    showError(msg, '추가하지 못했어요. 인터넷 연결을 확인해 주세요.');
  } finally {
    btn.disabled = false;
    updatePastePreview();
  }
}

// 반 단위 범위
function rangeSids() {
  const g = Number($('rGrade').value), c = Number($('rClass').value);
  const from = Number($('rFrom').value), to = Number($('rTo').value);
  if (!(c >= 1 && c <= 19 && from >= 1 && to <= 49 && from <= to)) return null;
  const p = n => String(n).padStart(2, '0');
  return Array.from({ length: to - from + 1 }, (_, i) => `${g}${p(c)}${p(from + i)}`);
}
function updateRangePreview() {
  const s = rangeSids();
  $('rangePreview').textContent = s
    ? `${s[0]} ~ ${s.at(-1)} (${s.length}명${s.filter(x => current[x]).length ? `, 이미 등록 ${s.filter(x => current[x]).length}명` : ''})`
    : '반은 1~19, 번호는 1~49 사이로, 시작 번호가 끝 번호보다 작아야 해요.';
  $('rangeBtn').disabled = !s;
}
for (const id of ['rGrade', 'rClass', 'rFrom', 'rTo']) $(id).addEventListener('input', updateRangePreview);
$('rangeBtn').addEventListener('click', () => { const s = rangeSids(); if (s) runAdd(s, $('rangeBtn')); });

// 붙여넣기
function parsePaste() {
  const tokens = $('pasteBox').value.split(/[\s,;]+/).map(t => t.trim()).filter(Boolean);
  const seen = new Set();
  const out = { add: [], dup: [], bad: [], repeat: 0 };
  for (const t of tokens) {
    if (seen.has(t)) { out.repeat++; continue; }
    seen.add(t);
    if (!isValidSid(t)) out.bad.push(t);
    else if (current[t]) out.dup.push(t);
    else out.add.push(t);
  }
  return out;
}
function updatePastePreview() {
  const r = parsePaste();
  const el = $('pastePreview');
  if (!$('pasteBox').value.trim()) { el.innerHTML = ''; $('pasteBtn').disabled = true; return; }
  el.innerHTML = `
    <span class="badge ok">추가 ${r.add.length}명</span>
    ${r.dup.length ? `<span class="badge">이미 등록 ${r.dup.length}</span>` : ''}
    ${r.repeat ? `<span class="badge">중복 입력 ${r.repeat}</span>` : ''}
    ${r.bad.length ? `<span class="badge danger">형식 오류 ${r.bad.length}</span>
      <span class="small">${r.bad.slice(0, 8).map(escapeHtml).join(', ')}${r.bad.length > 8 ? ' …' : ''}</span>` : ''}`;
  $('pasteBtn').disabled = !r.add.length;
}
$('pasteBox').addEventListener('input', updatePastePreview);
$('pasteBtn').addEventListener('click', () => runAdd(parsePaste().add, $('pasteBtn'), () => { $('pasteBox').value = ''; }));

// 한 명
$('oneSid').addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, ''); });
function addOne() {
  const sid = $('oneSid').value.trim();
  if (!isValidSid(sid)) return showError($('rosterMsg'), '학번 5자리를 확인해 주세요. 예: 10101');
  if (current[sid]) return showError($('rosterMsg'), `${sid}은(는) 이미 등록되어 있어요.`);
  runAdd([sid], $('oneBtn'), () => { $('oneSid').value = ''; $('oneSid').focus(); });
}
$('oneBtn').addEventListener('click', addOne);
$('oneSid').addEventListener('keydown', e => { if (e.key === 'Enter') addOne(); });

// ----- 삭제 -----
async function removeStudents(sids, label) {
  const online = sids.filter(s => presence[s] && presence[s].online).length;
  const ok = await confirmDialog({
    title: `${label} 삭제`,
    body: `명단, 비밀번호, 진행 기록, 접속 기록이 지워져요.${online ? `\n지금 접속 중인 학생이 ${online}명 있어요. 이 학생들은 더 이상 저장할 수 없게 돼요.` : ''}\n이미 저장된 평가 결과는 지워지지 않아요.`,
    ok: '삭제', danger: true,
  });
  if (!ok) return;
  try {
    const patch = {};
    for (const s of sids) {
      patch[`roster/${s}`] = null; patch[`pins/${s}`] = null;
      patch[`progress/${s}`] = null; patch[`presence/${s}`] = null; patch[`loginAttempts/${s}`] = null;
    }
    // 학급의 학생이 모두 지워지면 그 학급의 평가 상태도 지운다
    const gone = new Set(sids);
    const remaining = Object.keys(current).filter(s => !gone.has(s));
    for (const cls of new Set(sids.map(s => (current[s] && current[s].classId) || classOf(s)))) {
      if (!remaining.some(s => ((current[s] && current[s].classId) || classOf(s)) === cls)) patch[`exam/classes/${cls}`] = null;
    }
    // 이 학번으로 로그인해 있던 기기 정보도 지운다
    const claims = (await get(ref(db, 'claims'))).val() || {};
    const set = new Set(sids);
    for (const [uid, c] of Object.entries(claims)) if (c && set.has(c.sid)) patch[`claims/${uid}`] = null;
    await update(ref(db), patch);
    toast(`${label}을(를) 삭제했어요.`);
  } catch (e) {
    console.error(e);
    toast('삭제하지 못했어요.');
  }
}

$('rosterGroups').addEventListener('click', e => {
  const btn = e.target.closest('button[data-del], button[data-del-class]');
  if (!btn) return;
  if (btn.dataset.del) removeStudents([btn.dataset.del], btn.dataset.del);
  else {
    const cls = btn.dataset.delClass;
    removeStudents(Object.keys(current).filter(s => (current[s].classId || classOf(s)) === cls), `${cls}반 전체`);
  }
});

// ----- 목록 -----
export function render(roster, pres) {
  current = roster || {};
  presence = pres || {};
  const key = Object.keys(current).sort().join(',');
  if (key === renderedKey) return; // 명단이 바뀌었을 때만 다시 그린다
  renderedKey = key;

  const groups = {};
  for (const sid of Object.keys(current).sort()) (groups[current[sid].classId || classOf(sid)] ||= []).push(sid);
  const classes = Object.keys(groups).sort(sortClass);
  $('rosterCount').textContent = `${Object.keys(current).length}명 · ${classes.length}개 반`;
  $('rosterGroups').innerHTML = classes.length ? classes.map(c => `
    <section class="r-group">
      <div class="r-head"><h3>${c}반 <span class="muted small">${groups[c].length}명</span></h3>
        <button type="button" class="btn-sm" data-del-class="${c}">반 전체 삭제</button></div>
      <ul class="r-chips">${groups[c].map(s => `
        <li><span>${s}</span><button type="button" class="chip-del" data-del="${s}" aria-label="${s} 삭제">×</button></li>`).join('')}</ul>
    </section>`).join('') : '<p class="muted">아직 등록된 학생이 없어요.</p>';
  updateRangePreview();
  updatePastePreview();
}

updateRangePreview();
