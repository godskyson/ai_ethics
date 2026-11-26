// 학생 한 명의 상태 계산과 상세 창. 실시간 대시보드와 결과 보기가 함께 쓴다.
import { COLORS } from './classifier.js';
import { classOf, fmtTime, fmtDuration, escapeHtml } from './common.js';

export const STEP_NAMES = ['대기', '모델 이름', '데이터 입력', '학습', '테스트', '윤리 서술', '제출 완료'];
export const ETHICS = [['privacy', '개인정보 활용 주의점'], ['bias', '인공지능 편향 주의점'], ['judgment', '인공지능 판단 주의점']];
const STALE_MS = 90_000; // 접속 중인데 이 시간 동안 신호가 없으면 "응답 없음"

// Firebase는 배열을 객체로 돌려줄 때가 있다
export const arr = v => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []).filter(x => x != null);

// 학생이 쓰는 값은 믿지 않는다: 숫자 칸은 숫자가 아니면 0으로 바꿔서, HTML에 그대로 넣어도 안전하게 한다.
export const num = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

// p: progress, pr: presence. now가 없으면(저장된 결과) 접속 상태는 따지지 않는다.
export function makeRow(sid, classId, p, pr, now = null) {
  p = p && typeof p === 'object' ? p : null;
  pr = pr && typeof pr === 'object' ? pr : null;
  const online = now != null && !!(pr && pr.online);
  return {
    sid, cls: classId || classOf(sid), p, pr, online,
    stale: online && num(pr.lastSeen) > 0 && now - num(pr.lastSeen) > STALE_MS,
    away: online && pr.state === 'away',
    step: p ? Math.min(Math.floor(num(p.step)), 6) : 0,
    submitted: !!(p && p.submitted === true),
    editing: !!(p && p.submitted !== true && num(p.submitCount) > 0),
    submitCount: p ? Math.floor(num(p.submitCount)) : 0,
    awayCount: pr ? Math.floor(num(pr.awayCount)) : 0,
    awayMs: pr ? num(pr.awayMs) : 0,
    pasteCount: pr ? Math.floor(num(pr.pasteCount)) : 0,
    neverSeen: !pr,
    live: now != null,
  };
}

export function stepLabel(r) {
  if (r.submitted) return '제출 완료';
  if (!r.p) return r.live ? (r.online ? '대기 중' : (r.neverSeen ? '미접속' : '시작 전')) : '기록 없음';
  return `${r.step}단계 · ${STEP_NAMES[r.step] || ''}`;
}

function detailHTML(r) {
  const p = r.p || {};
  const ds = arr(p.dataset);
  const tests = arr(p.tests);
  const ethics = p.ethics || {};
  const colorOf = label => Math.max(0, ds.findIndex(d => d.label === label)) % COLORS;
  const state = r.live ? `<div>상태<b>${!r.online ? '오프라인' : r.away ? '이탈 중' : '집중'}</b></div>` : '';
  return `
    <div class="d-sec"><div class="d-grid">
      ${state}
      <div>단계<b>${escapeHtml(stepLabel(r))}</b></div>
      <div>이탈<b>${r.awayCount}회 · ${fmtDuration(r.awayMs)}</b></div>
      <div>붙여넣기<b>${r.pasteCount}회</b></div>
      <div>제출<b>${num(p.submittedAt) ? fmtTime(num(p.submittedAt)) : '-'}${r.submitCount > 1 ? ` (${r.submitCount}회)` : ''}</b></div>
    </div></div>
    <div class="d-sec"><h3>모델 이름</h3><p class="d-text ${p.modelName ? '' : 'empty'}">${escapeHtml(p.modelName || '아직 입력하지 않았어요')}</p></div>
    <div class="d-sec"><h3>학습 데이터</h3>${ds.length ? ds.map((d, i) => `
      <div class="d-class" style="--cc: var(--c${i % COLORS})"><h4>${escapeHtml(d.label || '(이름 없음)')} · ${arr(d.texts).length}문장</h4>
      <p>${arr(d.texts).map(escapeHtml).join(' / ')}</p></div>`).join('') : '<p class="d-text empty">아직 입력하지 않았어요</p>'}</div>
    <div class="d-sec"><h3>테스트 문장</h3>${tests.some(t => t.text) ? tests.map((t, i) => {
      const probs = arr(t.probs);
      return `<div class="d-test"><b>${i + 1}.</b> ${escapeHtml(t.text || '')}
        ${t.top ? `<div>→ <span class="badge" style="background: var(--c${colorOf(t.top)})">${escapeHtml(t.top)}</span>
        <span class="probs">${probs.map(q => `${escapeHtml(q.label ?? '')} ${(num(q.prob) * 100).toFixed(1)}%`).join(' · ')}</span></div>` : '<div class="probs">분류 전</div>'}</div>`;
    }).join('') : '<p class="d-text empty">아직 입력하지 않았어요</p>'}</div>
    ${ETHICS.map(([k, title]) => {
      const text = String(ethics[k] ?? '').trim();
      return `<div class="d-sec"><h3>${title} <span class="small muted">${text.length}자</span></h3>
        <p class="d-text ${text ? '' : 'empty'}">${escapeHtml(text || '아직 쓰지 않았어요')}</p></div>`;
    }).join('')}`;
}

// ----- 상세 창 (#detail) -----
let getRow = null; // 열려 있는 동안 최신 행을 돌려주는 함수

export function openDetail(rowGetter, subtitle = '') {
  getRow = rowGetter;
  refreshDetail(subtitle);
  const dlg = document.getElementById('detail');
  if (!dlg.open) dlg.showModal();
}

let lastSubtitle = '';
export function refreshDetail(subtitle) {
  if (subtitle !== undefined) lastSubtitle = subtitle;
  const dlg = document.getElementById('detail');
  if (!getRow) return;
  const r = getRow();
  if (!r) { if (dlg.open) dlg.close(); return; }
  document.getElementById('detailTitle').textContent = `${r.sid} (${r.cls}반)${lastSubtitle ? ' · ' + lastSubtitle : ''}`;
  document.getElementById('detailBody').innerHTML = detailHTML(r);
}

export function isDetailOpen() { return document.getElementById('detail').open; }

document.getElementById('detailClose').addEventListener('click', () => document.getElementById('detail').close());
document.getElementById('detail').addEventListener('close', () => { getRow = null; });
