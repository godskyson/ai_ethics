// 학생 평가 화면: 1 모델 이름 → 2 데이터 → 3 학습 → 4 테스트 → 5 윤리 서술 → 제출
// 진행 상태는 progress/{sid}에 자동 저장되고, 다시 로그인하면 이어서 한다.
import { db, ref, get, update, serverTimestamp, increment, isPermissionDenied } from './firebase.js';
import { COLORS, splitItems, train, predict, toTestRecord, tokenize } from './classifier.js';
import { MIN_CHARS, LIMITS, debounce, escapeHtml, showError, fmtTime, confirmDialog, toast } from './common.js';

const $ = id => document.getElementById(id);

const ETHICS = [
  { key: 'privacy', title: '개인정보 활용 주의점',
    hint: '학습 데이터나 테스트 문장에 이름, 연락처, 학교 같은 정보가 들어가면 어떤 문제가 생길까요?' },
  { key: 'bias', title: '인공지능 편향 주의점',
    hint: '학습 데이터가 한쪽으로 치우치면 결과가 어떻게 달라질까요? 내 모델의 테스트 결과에서 찾아보세요.' },
  { key: 'judgment', title: '인공지능 판단 주의점',
    hint: '확률이 낮거나 틀린 결과가 나온 문장이 있었나요? 인공지능의 판단을 그대로 믿으면 어떤 위험이 있을까요?' },
];

// ----- 상태 -----
let sid = null;
let onChange = () => {};      // 제출 상태가 바뀌면 student.js가 화면을 다시 고른다
let loaded = false;
let loading = null;
let minChars = MIN_CHARS;
let model = null;
let data = emptyData();

function emptyData() {
  return {
    step: 1, modelName: '', dataset: [], tests: [{ text: '' }, { text: '' }, { text: '' }],
    ethics: { privacy: '', bias: '', judgment: '' },
    submitted: false, submittedAt: 0, submitCount: 0,
  };
}

// Firebase는 배열을 객체로 돌려줄 때가 있다
const arr = v => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : []).filter(x => x != null);

function normalize(p) {
  const d = emptyData();
  if (!p) return d;
  d.step = Number(p.step) || 1;
  d.modelName = p.modelName || '';
  d.dataset = arr(p.dataset).map(c => ({ label: c.label || '', texts: arr(c.texts) }));
  const tests = arr(p.tests);
  d.tests = [0, 1, 2].map(i => tests[i] ? { ...tests[i], probs: arr(tests[i].probs) } : { text: '' });
  d.ethics = { ...d.ethics, ...(p.ethics || {}) };
  d.submitted = p.submitted === true;
  d.submittedAt = p.submittedAt || 0;
  d.submitCount = p.submitCount || 0;
  return d;
}

// ----- 외부에 공개하는 함수 -----
export function init(opts) { onChange = opts.onChange || onChange; }
export function isLoaded() { return loaded; }
export function isSubmitted() { return data.submitted; }

export function load(studentId) {
  if (loading && sid === studentId) return loading;
  sid = studentId;
  loading = (async () => {
    const [p, mc] = await Promise.all([
      get(ref(db, `progress/${sid}`)).then(s => s.val()),
      get(ref(db, 'exam/minChars')).then(s => s.val()).catch(() => null),
    ]);
    minChars = Number(mc) || MIN_CHARS;
    data = normalize(p);
    model = null;
    renderAll();
    let step = Math.min(Math.max(data.step, 1), 5);
    if (step >= 3) {
      if (validateDataset(data.dataset)) step = 2; // 저장된 데이터로 학습할 수 없으면 데이터 입력부터
      else { model = train(data.dataset); if (step === 3) step = 4; }
    }
    current = 0;
    if (step === 5) renderSummary();
    go(step, { save: false });
    if (data.submitted) renderDone();
    loaded = true;
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

export function unload() {
  flush();
  loaded = false;
  loading = null;
  sid = null;
  data = emptyData();
  model = null;
  setSaveText('');
}

// 아직 보내지 않은 저장을 바로 보낸다
export function flush() { if (pendingPatch) saveDebounced.flush(); }

// ----- 저장 -----
let pendingPatch = null;

function setSaveText(text, err = false) {
  const el = $('saveState');
  el.textContent = text;
  el.classList.toggle('err', err);
}

async function sendPatch() {
  if (!pendingPatch || !sid) return;
  const patch = { ...pendingPatch, updatedAt: serverTimestamp() };
  pendingPatch = null;
  setSaveText('저장 중…');
  try {
    await update(ref(db, `progress/${sid}`), patch);
    setSaveText(`저장됨 · ${fmtTime(Date.now())}`);
  } catch (e) {
    console.error(e);
    setSaveText(isPermissionDenied(e) ? '저장하지 못했어요 (평가가 진행 중이 아니에요)' : '저장하지 못했어요. 인터넷 연결을 확인해 주세요.', true);
    throw e;
  }
}
const saveDebounced = debounce(() => sendPatch().catch(() => {}), 2000);

// 글을 쓰는 동안: 2초 뒤에 저장
function saveLater(patch) {
  pendingPatch = { ...pendingPatch, ...patch };
  setSaveText('입력 중…');
  saveDebounced();
}
// 단계가 바뀔 때: 바로 저장
function saveNow(patch) {
  pendingPatch = { ...pendingPatch, ...patch };
  saveDebounced.flush();
}
// 제출처럼 결과를 꼭 알아야 할 때
async function saveAwait(patch) {
  pendingPatch = { ...pendingPatch, ...patch };
  await sendPatch();
}

// ----- 단계 전환 -----
const steps = [...document.querySelectorAll('[data-screen="exam"] [data-step]')];
const stepItems = [...document.querySelectorAll('#stepper .item')];
const stepBars = [...document.querySelectorAll('#stepper .bar')];
let current = 0;
let stepTimer = null;

function go(step, { save = true } = {}) {
  const back = step < current;
  const prev = steps.find(s => s.classList.contains('show'));
  const next = steps.find(s => +s.dataset.step === step);
  current = step;
  data.step = step;
  if (save && step !== 3) saveNow({ step });

  stepItems.forEach((el, i) => {
    el.classList.toggle('active', i + 1 === step);
    el.classList.toggle('done', i + 1 < step);
    if (i + 1 === step) el.setAttribute('aria-current', 'step'); else el.removeAttribute('aria-current');
  });
  stepBars.forEach((el, i) => el.classList.toggle('done', i + 2 <= step));

  clearTimeout(stepTimer);
  steps.forEach(s => { if (s !== next && s !== prev) s.classList.remove('show', 'leave', 'back'); });
  const show = () => {
    steps.forEach(s => { if (s !== next) s.classList.remove('show', 'leave', 'back'); });
    next.classList.toggle('back', back);
    next.classList.add('show');
    const focusEl = next.querySelector('input:not([disabled]), textarea');
    if (focusEl && step !== 5) focusEl.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  if (!prev || prev === next) return show();
  prev.classList.remove('show');
  prev.classList.add('leave');
  prev.classList.toggle('back', back);
  stepTimer = setTimeout(show, 180);
}

function renderAll() {
  $('modelName').value = data.modelName;
  renderClasses();
  renderTests();
  renderEthics();
  $('minCharsTxt').textContent = minChars;
}

// ----- 1단계: 모델 이름 -----
$('modelName').addEventListener('input', e => {
  data.modelName = e.target.value.slice(0, LIMITS.modelName);
  saveLater({ modelName: data.modelName });
});
function submitName() {
  const name = $('modelName').value.trim();
  if (!name) return showError($('nameMsg'), '모델 이름을 입력해 주세요.');
  $('nameMsg').textContent = '';
  data.modelName = name;
  saveNow({ modelName: name });
  go(2);
}
$('toData').addEventListener('click', submitName);
$('modelName').addEventListener('keydown', e => { if (e.key === 'Enter') submitName(); });

// ----- 2단계: 데이터 입력 -----
const classesEl = $('classes');

function recolor() {
  [...classesEl.children].forEach((card, i) => card.style.setProperty('--cc', `var(--c${i % COLORS})`));
  $('addClass').disabled = classesEl.children.length >= LIMITS.maxClasses;
}

function addClassCard(name = '', texts = []) {
  const card = document.createElement('div');
  card.className = 'class-card';
  card.innerHTML = `
    <div class="class-head">
      <input type="text" class="cname" placeholder="클래스 이름 (예: 긍정)" aria-label="클래스 이름" maxlength="${LIMITS.className}" autocomplete="off">
      <button type="button" class="btn-del" aria-label="클래스 삭제">삭제</button>
    </div>
    <textarea class="cdata" placeholder="문장1, 문장2, 문장3, 문장4, 문장5" aria-label="예시 문장 (쉼표로 구분)"></textarea>
    <div class="count"><span class="n"></span><span class="hint"></span></div>`;
  card.querySelector('.cname').value = name;
  card.querySelector('.cdata').value = texts.join(', ');
  card.querySelector('.cname').addEventListener('input', saveDataset);
  card.querySelector('.cdata').addEventListener('input', () => { updateCount(card); saveDataset(); });
  card.querySelector('.btn-del').addEventListener('click', () => {
    if (classesEl.children.length <= 1) return;
    card.remove(); recolor(); saveDataset();
  });
  classesEl.appendChild(card);
  recolor();
  updateCount(card);
  return card;
}

function updateCount(card) {
  const items = splitItems(card.querySelector('.cdata').value);
  const n = items.length;
  const long = items.filter(t => t.length > LIMITS.textLen).length;
  const el = card.querySelector('.count');
  el.querySelector('.n').textContent = `문장 ${n}개`;
  const [hint, bad] =
    long ? [`${LIMITS.textLen}자가 넘는 문장이 ${long}개 있어요`, true] :
    n > LIMITS.maxTexts ? [`최대 ${LIMITS.maxTexts}개까지예요 (${n - LIMITS.maxTexts}개 줄여 주세요)`, true] :
    n < LIMITS.minTexts ? [`${LIMITS.minTexts - n}개 더 필요해요`, true] : ['충분해요 ✓', false];
  el.querySelector('.hint').textContent = hint;
  el.classList.toggle('bad', bad);
  el.classList.toggle('good', !bad);
}

function readDataset() {
  return [...classesEl.querySelectorAll('.class-card')].map(c => ({
    label: c.querySelector('.cname').value.trim(),
    texts: splitItems(c.querySelector('.cdata').value),
  }));
}

// 입력 중인 데이터도 저장한다 (규칙의 길이·개수 제한에 맞춰 잘라서)
function saveDataset() {
  data.dataset = readDataset();
  const draft = data.dataset.slice(0, LIMITS.maxClasses).map(c => ({
    label: c.label.slice(0, LIMITS.className),
    texts: c.texts.slice(0, LIMITS.maxTexts).map(t => t.slice(0, LIMITS.textLen)),
  }));
  saveLater({ dataset: draft });
}

function renderClasses() {
  classesEl.innerHTML = '';
  const ds = data.dataset.length ? data.dataset : [{ label: '', texts: [] }, { label: '', texts: [] }];
  ds.forEach(c => addClassCard(c.label, c.texts));
}

$('addClass').addEventListener('click', () => {
  if (classesEl.children.length >= LIMITS.maxClasses) return;
  addClassCard().querySelector('.cname').focus();
  saveDataset();
});
$('backTo1').addEventListener('click', () => go(1));

// 문제가 있으면 [메시지, 문제 위치(카드 번호), 칸 종류]를 돌려준다
function validateDataset(ds) {
  if (ds.length < LIMITS.minClasses) return ['클래스가 2개 이상 있어야 학습할 수 있어요.', -1];
  for (let i = 0; i < ds.length; i++) {
    const d = ds[i];
    if (!d.label) return ['이름이 비어 있는 클래스가 있어요.', i, 'cname'];
    if (ds.findIndex(o => o.label === d.label) !== i) return ['클래스 이름이 서로 달라야 해요.', i, 'cname'];
    if (d.texts.length < LIMITS.minTexts) return [`'${d.label}' 클래스에 문장이 ${LIMITS.minTexts - d.texts.length}개 더 필요해요.`, i, 'cdata'];
    if (d.texts.length > LIMITS.maxTexts) return [`'${d.label}' 클래스의 문장은 ${LIMITS.maxTexts}개까지 쓸 수 있어요.`, i, 'cdata'];
    if (d.texts.some(t => t.length > LIMITS.textLen)) return [`'${d.label}' 클래스에 ${LIMITS.textLen}자가 넘는 문장이 있어요.`, i, 'cdata'];
  }
  return null;
}

$('trainBtn').addEventListener('click', () => {
  const ds = readDataset();
  const err = validateDataset(ds);
  if (err) {
    const [text, i, field] = err;
    const cards = classesEl.querySelectorAll('.class-card');
    (i >= 0 ? cards[i].querySelector(`.${field}`) : $('addClass')).focus();
    return showError($('trainMsg'), text);
  }
  $('trainMsg').textContent = '';
  data.dataset = ds;
  model = train(ds);

  // 이미 분류해 둔 테스트 문장은 새 모델로 다시 계산한다
  let recalculated = 0;
  data.tests = data.tests.map(t => {
    if (!t.text) return { text: '' };
    if (t.top) recalculated++;
    return toTestRecord(t.text, predict(model, t.text));
  });
  saveNow({ dataset: ds, tests: data.tests, trainedAt: serverTimestamp() });
  go(3);
  playTraining(ds, () => {
    renderTests();
    go(4);
    if (recalculated) toast('데이터가 바뀌어서 테스트 결과를 새 모델로 다시 계산했어요.', 3500);
  });
});

// ----- 3단계: 학습 애니메이션 (참고 원본과 같은 연출) -----
const TRAIN_MS = 2000;
function playTraining(ds, done) {
  const bar = $('progressBar'), pct = $('trainPct'), status = $('trainStatus'), title = $('trainTitle'), binsEl = $('bins');
  title.textContent = '학습하는 중';
  binsEl.innerHTML = '';
  const bins = ds.map((d, i) => {
    const bin = document.createElement('div');
    bin.className = 'bin';
    bin.style.setProperty('--cc', `var(--c${i % COLORS})`);
    bin.innerHTML = `<div class="bin-head"><span></span><span class="n">0</span></div><div class="bin-body"></div>`;
    bin.querySelector('.bin-head span').textContent = d.label;
    binsEl.appendChild(bin);
    const pieces = [...new Set(d.texts.flatMap(t => tokenize(t))
      .filter(t => t.startsWith('b:') || t.startsWith('w:')).map(t => t.slice(2)))];
    return {
      count: bin.querySelector('.n'), body: bin.querySelector('.bin-body'),
      total: model.classes[i].total,
      pieces: pieces.sort(() => Math.random() - .5).slice(0, 10), shown: 0,
    };
  });
  const messages = ['문장을 조각으로 나누는 중', '클래스별로 조각 개수를 세는 중', '확률을 계산하는 중'];
  const start = performance.now();
  function frame(now) {
    const t = Math.min((now - start) / TRAIN_MS, 1);
    const ease = 1 - Math.pow(1 - t, 2);
    bar.style.transform = `scaleX(${ease})`;
    pct.textContent = Math.round(ease * 100) + '%';
    status.textContent = messages[Math.min(Math.floor(t * messages.length), messages.length - 1)];
    for (const b of bins) {
      b.count.textContent = `조각 ${Math.round(ease * b.total)}개`;
      while (b.shown < Math.floor(t * b.pieces.length)) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = b.pieces[b.shown++];
        b.body.appendChild(chip);
      }
    }
    if (t < 1) return requestAnimationFrame(frame);
    title.textContent = '학습 완료';
    status.innerHTML = '<span class="train-done">테스트 화면으로 넘어갑니다.</span>';
    setTimeout(done, 800);
  }
  requestAnimationFrame(frame);
}

// ----- 4단계: 테스트 -----
function colorOf(label) {
  const i = data.dataset.findIndex(d => d.label === label);
  return (i < 0 ? 0 : i) % COLORS;
}

// 결과 막대 그리기. probs: [{label, prob}] (확률 내림차순)
function renderResult(el, probs, text) {
  if (!probs || !probs.length) { el.innerHTML = ''; return; }
  const top = probs[0];
  el.innerHTML =
    `<p class="result-top">결과 <b style="--cc: var(--c${colorOf(top.label)})">${escapeHtml(top.label)}</b></p>` +
    probs.map(p => `
      <div class="bar-row" style="--cc: var(--c${colorOf(p.label)})">
        <div class="bar-label">${escapeHtml(p.label)}</div>
        <div class="bar"><span></span></div>
        <div class="pct">${(p.prob * 100).toFixed(1)}%</div>
      </div>`).join('') +
    (text ? `<p class="result-hint">“${escapeHtml(text)}”에 대한 클래스별 확률이에요.</p>` : '');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.querySelectorAll('.bar > span').forEach((s, i) => { s.style.transform = `scaleX(${probs[i].prob})`; });
  }));
}

function runFree() {
  const text = $('freeInput').value.trim();
  if (!model) return;
  if (!text) { $('freeInput').focus(); return; }
  renderResult($('freeResult'), predict(model, text), text);
}
$('freeBtn').addEventListener('click', runFree);
$('freeInput').addEventListener('keydown', e => { if (e.key === 'Enter') runFree(); });

function renderTests() {
  $('modelTag').textContent = data.modelName || '내';
  $('freeResult').innerHTML = '';
  const box = $('tests');
  box.innerHTML = '';
  data.tests.forEach((t, i) => {
    const card = document.createElement('div');
    card.className = 'test-card';
    card.innerHTML = `
      <div class="test-card-head"><span>테스트 ${i + 1}</span><span class="state"></span></div>
      <div class="test-card-body">
        <div class="test-row">
          <input type="text" placeholder="테스트할 문장" maxlength="${LIMITS.textLen}" autocomplete="off" aria-label="테스트 ${i + 1} 문장">
          <button type="button">분류하기</button>
        </div>
        <div class="result"></div>
      </div>`;
    const input = card.querySelector('input');
    const btn = card.querySelector('button');
    const result = card.querySelector('.result');
    const stateEl = card.querySelector('.state');
    input.value = t.text || '';
    const refresh = () => {
      const r = data.tests[i];
      if (r.top) { renderResult(result, r.probs); stateEl.innerHTML = '<span class="badge ok">분류함</span>'; }
      else { result.innerHTML = ''; stateEl.innerHTML = r.text ? '<span class="stale">분류하기를 눌러 주세요</span>' : ''; }
    };
    const classify = () => {
      const text = input.value.trim();
      if (!text) { input.focus(); return; }
      if (!model) return;
      data.tests[i] = toTestRecord(text, predict(model, text));
      refresh();
      saveNow({ tests: data.tests });
    };
    input.addEventListener('input', () => {
      // 문장을 고치면 이전 결과는 무효
      data.tests[i] = { text: input.value.trim() };
      refresh();
      saveLater({ tests: data.tests });
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') classify(); });
    btn.addEventListener('click', classify);
    refresh();
    box.appendChild(card);
  });
}

$('backTo2').addEventListener('click', () => go(2));
$('toEthics').addEventListener('click', () => {
  const missing = data.tests.findIndex(t => !t.top);
  if (missing >= 0) {
    $('tests').children[missing].querySelector('input').focus();
    return showError($('testMsg'), `테스트 ${missing + 1}을(를) 아직 분류하지 않았어요. 세 문장 모두 분류해 주세요.`);
  }
  $('testMsg').textContent = '';
  renderSummary();
  go(5);
});

// ----- 5단계: 윤리 서술 -----
function renderSummary() {
  $('testSummary').innerHTML = data.tests.map((t, i) => {
    const top = t.probs && t.probs[0];
    return `<div class="sum-row">
      <span class="n">${i + 1}</span>
      <span class="t">${escapeHtml(t.text || '')}</span>
      <span class="r">${top ? `<b style="--cc: var(--c${colorOf(top.label)})">${escapeHtml(top.label)}</b> ${(top.prob * 100).toFixed(1)}%` : '-'}</span>
    </div>`;
  }).join('');
}

function renderEthics() {
  const box = $('ethics');
  box.innerHTML = '';
  for (const e of ETHICS) {
    const item = document.createElement('div');
    item.className = 'eth-item';
    const id = `eth-${e.key}`;
    item.innerHTML = `
      <div class="eth-head"><h3><label for="${id}"></label></h3><p></p></div>
      <textarea id="${id}" maxlength="${LIMITS.ethicsMax}" placeholder="테스트 결과를 근거로 써 주세요."></textarea>
      <div class="count"><span class="n"></span><span class="hint"></span></div>`;
    item.querySelector('label').textContent = e.title;
    item.querySelector('.eth-head p').textContent = e.hint;
    const ta = item.querySelector('textarea');
    ta.value = data.ethics[e.key] || '';
    const count = () => {
      const n = ta.value.trim().length;
      const el = item.querySelector('.count');
      el.querySelector('.n').textContent = `${n}자`;
      el.querySelector('.hint').textContent = n < minChars ? `${minChars - n}자 더 써 주세요` : '충분해요 ✓';
      el.classList.toggle('bad', n < minChars);
      el.classList.toggle('good', n >= minChars);
    };
    ta.addEventListener('input', () => {
      data.ethics[e.key] = ta.value;
      count();
      saveLater({ ethics: { ...data.ethics } });
    });
    count();
    box.appendChild(item);
  }
}

$('backTo4').addEventListener('click', () => go(4));

$('submitBtn').addEventListener('click', async () => {
  const short = ETHICS.find(e => (data.ethics[e.key] || '').trim().length < minChars);
  if (short) {
    $(`eth-${short.key}`).focus();
    return showError($('ethicsMsg'), `'${short.title}'을(를) ${minChars}자 이상 써 주세요.`);
  }
  if (data.tests.some(t => !t.top)) return showError($('ethicsMsg'), '테스트 문장 3개를 모두 분류해야 제출할 수 있어요.');
  $('ethicsMsg').textContent = '';
  const ok = await confirmDialog({
    title: '제출할까요?',
    body: '평가가 끝나기 전까지는 수정하기로 다시 고칠 수 있어요.',
    ok: '제출하기',
  });
  if (!ok) return;
  const btn = $('submitBtn');
  btn.disabled = true;
  try {
    const ethics = Object.fromEntries(ETHICS.map(e => [e.key, (data.ethics[e.key] || '').trim()]));
    await saveAwait({
      ethics, tests: data.tests, modelName: data.modelName,
      submitted: true, submittedAt: serverTimestamp(), submitCount: increment(1), step: 6,
    });
    data.ethics = ethics;
    data.submitted = true;
    data.submittedAt = Date.now();
    data.submitCount++;
    renderDone();
    onChange();
    toast('제출했어요!');
  } catch {
    showError($('ethicsMsg'), '제출하지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.');
  } finally {
    btn.disabled = false;
  }
});

// ----- 제출 완료 -----
function renderDone() {
  $('doneWhen').textContent = `제출 시각 ${fmtTime(data.submittedAt)}${data.submitCount > 1 ? ` · ${data.submitCount}번째 제출` : ''}`;
  const tests = data.tests.map((t, i) => {
    const top = t.probs && t.probs[0];
    return `<div class="sum-row"><span class="n">${i + 1}</span><span class="t">${escapeHtml(t.text || '')}</span>
      <span class="r">${top ? `<b style="--cc: var(--c${colorOf(top.label)})">${escapeHtml(top.label)}</b> ${(top.prob * 100).toFixed(1)}%` : '-'}</span></div>`;
  }).join('');
  $('doneView').innerHTML = `
    <div class="view-sec"><h3>모델</h3><p class="view-text">${escapeHtml(data.modelName)} · 클래스 ${data.dataset.map(d => escapeHtml(d.label)).join(', ')}</p></div>
    <div class="view-sec"><h3>테스트 결과</h3><div class="test-summary">${tests}</div></div>
    ${ETHICS.map(e => `<div class="view-sec"><h3>${e.title}</h3><p class="view-text">${escapeHtml(data.ethics[e.key] || '')}</p></div>`).join('')}`;
}

$('editBtn').addEventListener('click', async () => {
  const btn = $('editBtn');
  btn.disabled = true;
  try {
    await saveAwait({ submitted: false, step: 5 });
    data.submitted = false;
    renderSummary();
    current = 0;
    go(5, { save: false });
    onChange();
  } catch {
    toast('지금은 수정할 수 없어요.');
  } finally {
    btn.disabled = false;
  }
});
