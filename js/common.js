// 학생 화면과 교사 화면이 함께 쓰는 유틸

export const INITIAL_PIN = '0000';
export const MIN_CHARS = 50;   // 윤리 서술 최소 글자 수 (exam/minChars가 없을 때 기본값)
export const LIMITS = {
  modelName: 30, className: 20, minClasses: 2, maxClasses: 6,
  minTexts: 5, maxTexts: 30, textLen: 100, tests: 3, ethicsMax: 1000,
};

// 학번: 학년(1~3) + 반(01~19) + 번호(01~49), 예: 20301
const SID_RE = /^[1-3](0[1-9]|1[0-9])(0[1-9]|[1-4][0-9])$/;
export function isValidSid(s) { return SID_RE.test(String(s)); }
export function isValidPin(p) { return /^\d{4}$/.test(String(p)); }

// '20301' → '2-3'
export function classOf(sid) {
  const s = String(sid);
  return `${s[0]}-${Number(s.slice(1, 3))}`;
}

// 비밀번호 해시: SHA-256("ai_ethics:" + 학번 + ":" + 비밀번호) 의 hex. 학번이 솔트 역할을 한다.
export async function hashPin(sid, pin) {
  const data = new TextEncoder().encode(`ai_ethics:${sid}:${pin}`);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// 평가 회차 ID: YYYYMMDD-HHmmss (같은 분에 종료·재시작해도 겹치지 않게 초까지 쓴다)
export function makeExamId(date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

// 타임스탬프(ms) → '09:12:30'
export function fmtTime(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 타임스탬프(ms) → '2026-11-04 09:12:30'
export function fmtDateTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${fmtTime(ms)}`;
}

// 지난 시간(ms) → '3분 20초'
export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m}분 ${s % 60}초` : `${s}초`;
}

export function debounce(fn, wait) {
  let t = null;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...args); }, wait); };
  d.flush = (...args) => { if (t) { clearTimeout(t); t = null; } fn(...args); };
  return d;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// 오류 메시지 표시 (흔들림 애니메이션 포함)
export function showError(el, text) {
  el.textContent = text;
  el.className = 'msg err';
  el.classList.remove('shake');
  void el.offsetWidth; // 애니메이션 다시 시작
  el.classList.add('shake');
}

export function showOk(el, text) {
  el.textContent = text;
  el.className = 'msg ok';
}

// 화면 아래쪽에 잠깐 나타나는 알림
export function toast(text, ms = 2600) {
  let box = document.getElementById('toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    box.className = 'toasts';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  box.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 200); }, ms);
}

// 확인 모달. 확인하면 true를 돌려준다.
export function confirmDialog({ title, body = '', ok = '확인', cancel = '취소', danger = false }) {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'modal';
    dlg.innerHTML = `
      <div class="modal-head"><h2></h2></div>
      <div class="modal-body"><p></p></div>
      <div class="modal-foot">
        <button type="button" class="btn-text" value="cancel"></button>
        <button type="button" class="${danger ? 'btn-danger' : 'btn-primary'}" value="ok"></button>
      </div>`;
    dlg.querySelector('h2').textContent = title;
    dlg.querySelector('p').textContent = body;
    const [c, o] = dlg.querySelectorAll('button');
    c.textContent = cancel;
    o.textContent = ok;
    const done = v => { dlg.close(); dlg.remove(); resolve(v); };
    c.addEventListener('click', () => done(false));
    o.addEventListener('click', () => done(true));
    dlg.addEventListener('cancel', e => { e.preventDefault(); done(false); });
    document.body.appendChild(dlg);
    dlg.showModal();
    o.focus();
  });
}
