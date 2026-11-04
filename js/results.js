// 결과 보기: 평가 종료 때 저장된 results/{examId} 스냅샷을 회차별로 보고 CSV로 내려받는다.
import { db, ref, onValue, remove } from './firebase.js';
import { fmtDateTime, fmtDuration, escapeHtml, toast, confirmDialog } from './common.js';
import { ETHICS, arr, makeRow, stepLabel, openDetail } from './detail.js';

const $ = id => document.getElementById(id);
let all = {};          // results 전체
let selected = null;   // 선택한 회차 ID
let unsub = null;

export function start() {
  if (unsub) return;
  $('examList').innerHTML = '<li class="muted">불러오는 중…</li>';
  unsub = onValue(ref(db, 'results'), snap => {
    all = snap.val() || {};
    if (selected && !all[selected]) selected = null;
    renderList();
    renderView();
  }, err => {
    console.error(err);
    $('examList').innerHTML = '<li class="muted">결과를 읽지 못했어요.</li>';
  });
}

export function stop() {
  if (unsub) { unsub(); unsub = null; }
  all = {};
  selected = null;
}

function rowsOf(examId) {
  const students = (all[examId] && all[examId].students) || {};
  return Object.keys(students).sort().map(sid => {
    const s = students[sid] || {};
    return makeRow(sid, s.classId, s.progress, s.presence);
  });
}

// ----- 회차 목록 -----
function renderList() {
  const ids = Object.keys(all).sort().reverse();
  if (!ids.length) { $('examList').innerHTML = '<li class="muted">아직 저장된 결과가 없어요. 평가를 종료하면 여기에 생겨요.</li>'; return; }
  $('examList').innerHTML = ids.map(id => {
    const rows = rowsOf(id);
    const sub = rows.filter(r => r.submitted).length;
    const meta = all[id].meta || {};
    return `<li><button type="button" class="exam-item ${id === selected ? 'on' : ''}" data-exam="${escapeHtml(id)}">
      <b>${escapeHtml(id)}</b>
      <span class="small">${meta.endedAt ? fmtDateTime(meta.endedAt) + ' 종료' : ''}</span>
      <span class="small">제출 ${sub} / ${rows.length}명</span>
    </button></li>`;
  }).join('');
}

$('examList').addEventListener('click', e => {
  const btn = e.target.closest('[data-exam]');
  if (!btn) return;
  selected = btn.dataset.exam;
  renderList();
  renderView();
});

// ----- 회차 상세 표 -----
function renderView() {
  const el = $('resultView');
  if (!selected || !all[selected]) { el.innerHTML = '<p class="muted">왼쪽에서 회차를 고르세요.</p>'; return; }
  const meta = all[selected].meta || {};
  const rows = rowsOf(selected);
  const classes = [...new Set(rows.map(r => r.cls))].sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
  const prevFilter = $('resultClass') ? $('resultClass').value : '';
  const filter = classes.includes(prevFilter) ? prevFilter : '';
  const shown = rows.filter(r => !filter || r.cls === filter);
  const sub = shown.filter(r => r.submitted).length;

  el.innerHTML = `
    <div class="rv-head">
      <div>
        <h2>${escapeHtml(selected)}</h2>
        <p class="small muted">${meta.startedAt ? fmtDateTime(meta.startedAt) + ' 시작 · ' : ''}${meta.endedAt ? fmtDateTime(meta.endedAt) + ' 종료' : ''}</p>
      </div>
      <div class="row">
        <label class="tool"><span>반</span><select id="resultClass"><option value="">전체</option>
          ${classes.map(c => `<option value="${c}" ${c === filter ? 'selected' : ''}>${c}반</option>`).join('')}</select></label>
        <button type="button" class="btn-primary" id="csvBtn">CSV 내려받기</button>
        <button type="button" class="btn-sm" id="delResultBtn">이 결과 삭제</button>
      </div>
    </div>
    <p class="rv-sum"><span class="badge ok">제출 ${sub}명</span> <span class="badge">미제출 ${shown.length - sub}명</span> <span class="muted small">총 ${shown.length}명</span></p>
    <div class="table-wrap"><table class="rtable">
      <thead><tr>
        <th>학번</th><th>반</th><th>단계</th><th>제출 시각</th><th>모델</th>
        <th>테스트 결과</th><th>서술 글자 수<br><span class="small muted">개인정보 / 편향 / 판단</span></th>
        <th>이탈</th><th>붙여넣기</th><th></th>
      </tr></thead>
      <tbody>${shown.map(r => {
        const p = r.p || {};
        const tests = arr(p.tests).map(t => t.top ? escapeHtml(t.top) : '-').join(' · ') || '-';
        const lens = ETHICS.map(([k]) => ((p.ethics || {})[k] || '').trim().length).join(' / ');
        return `<tr class="${r.submitted ? '' : 'unsub'}">
          <td class="num">${r.sid}</td><td>${r.cls}</td>
          <td>${escapeHtml(stepLabel(r))}${r.editing ? ' <span class="badge warn">수정 중</span>' : ''}</td>
          <td class="num">${p.submittedAt ? fmtDateTime(p.submittedAt).slice(11) : '-'}${(p.submitCount || 0) > 1 ? ` <span class="small muted">(${p.submitCount}회)</span>` : ''}</td>
          <td>${escapeHtml(p.modelName || '-')}</td>
          <td>${tests}</td>
          <td class="num">${p.ethics ? lens : '-'}</td>
          <td class="num ${r.awayCount ? 'hot' : ''}">${r.awayCount}회 · ${fmtDuration(r.awayMs)}</td>
          <td class="num ${r.pasteCount ? 'hot' : ''}">${r.pasteCount}회</td>
          <td><button type="button" class="btn-sm" data-view="${r.sid}">보기</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;

  $('resultClass').addEventListener('change', renderView);
  $('csvBtn').addEventListener('click', () => downloadCsv(selected, shown, filter));
  $('delResultBtn').addEventListener('click', () => deleteResult(selected));
}

$('resultView').addEventListener('click', e => {
  const btn = e.target.closest('[data-view]');
  if (!btn) return;
  const id = selected, sid = btn.dataset.view;
  openDetail(() => rowsOf(id).find(r => r.sid === sid), `${id} 결과`);
});

async function deleteResult(id) {
  const ok = await confirmDialog({
    title: '결과를 삭제할까요?',
    body: `${id} 회차의 저장된 결과를 지워요. 되돌릴 수 없어요.\n필요하면 먼저 CSV로 내려받아 두세요.`,
    ok: '삭제', danger: true,
  });
  if (!ok) return;
  try {
    await remove(ref(db, `results/${id}`));
    toast(`${id} 결과를 삭제했어요.`);
  } catch (e) { console.error(e); toast('삭제하지 못했어요.'); }
}

// ----- CSV -----
const CSV_HEAD = ['학번', '반', '최종단계', '제출여부', '제출시각', '제출횟수', '모델이름', '클래스목록',
  '테스트1', '결과1', '테스트2', '결과2', '테스트3', '결과3', '개인정보', '편향', '판단',
  '이탈횟수', '이탈시간(초)', '붙여넣기횟수'];

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  const lines = [CSV_HEAD];
  for (const r of rows) {
    const p = r.p || {};
    const tests = arr(p.tests);
    const ethics = p.ethics || {};
    const testCols = [0, 1, 2].flatMap(i => {
      const t = tests[i] || {};
      const top = arr(t.probs)[0];
      return [t.text || '', t.top ? `${t.top} ${top ? (top.prob * 100).toFixed(1) + '%' : ''}`.trim() : ''];
    });
    lines.push([
      r.sid, r.cls, stepLabel(r), r.submitted ? 'O' : 'X', fmtDateTime(p.submittedAt), p.submitCount || 0,
      p.modelName || '', arr(p.dataset).map(d => d.label).join(' / '),
      ...testCols,
      (ethics.privacy || '').trim(), (ethics.bias || '').trim(), (ethics.judgment || '').trim(),
      r.awayCount, Math.round(r.awayMs / 1000), r.pasteCount,
    ]);
  }
  // 엑셀에서 한글이 깨지지 않도록 BOM을 붙인다
  return '﻿' + lines.map(l => l.map(csvCell).join(',')).join('\r\n');
}

function downloadCsv(id, rows, cls) {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ai_ethics_${id}${cls ? '_' + cls + '반' : ''}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
