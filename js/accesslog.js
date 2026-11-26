// 교사 계정 접속 기록: 교사 화면에 들어올 때마다 IP·시각·기기를 teacherLog에 남기고,
// 로그아웃 옆 '접속 기록' 버튼으로 최근 기록을 본다. 다른 사람이 교사 계정으로 들어왔는지 확인하는 용도.
// 브라우저는 자기 공인 IP를 알 수 없어서 공개 IP 확인 서비스(api.ipify.org)에 한 번 물어본다.
import { db, ref, get, push, remove, serverTimestamp } from './firebase.js';
import { fmtDateTime, escapeHtml } from './common.js';

// 학교망에서 막힌 서비스가 있을 수 있어 차례로 시도한다 (api.ipify.org는 이 학교망에서 막혀 있었다)
const IP_SERVICES = [
  ['https://api64.ipify.org?format=json', t => JSON.parse(t).ip],
  ['https://icanhazip.com', t => t],
  ['https://api.ipify.org?format=json', t => JSON.parse(t).ip],
];
const IP_RE = /^[0-9a-fA-F:.]{3,64}$/; // IPv4 또는 IPv6 모양인지
const KEEP = 30;                        // 최근 30개만 보관
const SHOW = 10;                        // 창에는 최근 10개
const SESSION_KEY = 'ai_ethics.teacher.logKey'; // 같은 탭에서 새로고침할 때는 다시 기록하지 않는다

let myKey = null;

async function fetchIp() {
  for (const [url, parse] of IP_SERVICES) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      const r = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
      const ip = String(parse(await r.text()) || '').trim();
      if (r.ok && IP_RE.test(ip)) return ip;
    } catch { /* 다음 서비스로 */ } finally {
      clearTimeout(timer);
    }
  }
  return '알 수 없음';
}

// 'Chrome · Windows' 같은 짧은 기기 설명
export function describeDevice(ua = navigator.userAgent) {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Whale\//.test(ua) ? 'Whale' : /SamsungBrowser/.test(ua) ? '삼성 인터넷'
    : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '브라우저';
  const os = /CrOS/.test(ua) ? 'ChromeOS' : /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}

// 교사 화면에 들어올 때 한 번 기록한다
export async function record() {
  try { myKey = sessionStorage.getItem(SESSION_KEY); } catch { myKey = null; }
  if (myKey) return; // 이 탭에서는 이미 기록함
  try {
    const ip = await fetchIp();
    const r = await push(ref(db, 'teacherLog'), { ip, at: serverTimestamp(), device: describeDevice() });
    myKey = r.key;
    try { sessionStorage.setItem(SESSION_KEY, myKey); } catch { /* 무시 */ }
    // 오래된 기록 정리 (push 키는 시간 순서라서 앞쪽이 오래된 것)
    const all = (await get(ref(db, 'teacherLog'))).val() || {};
    const keys = Object.keys(all).sort();
    await Promise.all(keys.slice(0, Math.max(0, keys.length - KEEP)).map(k => remove(ref(db, `teacherLog/${k}`))));
  } catch (e) {
    console.error('접속 기록을 남기지 못했어요', e);
  }
}

export function forget() {
  myKey = null;
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* 무시 */ }
}

// 접속 기록 창
export async function open() {
  const dlg = document.getElementById('accessLog');
  const body = document.getElementById('accessLogBody');
  body.innerHTML = '<p class="muted">불러오는 중…</p>';
  if (!dlg.open) dlg.showModal();
  try {
    const all = (await get(ref(db, 'teacherLog'))).val() || {};
    const keys = Object.keys(all).sort().reverse().slice(0, SHOW);
    if (!keys.length) { body.innerHTML = '<p class="muted">아직 기록이 없어요.</p>'; return; }
    const prev = keys.find(k => k !== myKey); // 지금 접속을 뺀 가장 최근 접속
    const p = prev && all[prev];
    body.innerHTML = `
      ${p ? `<div class="log-last"><span class="small muted">이전 접속</span>
        <b>${fmtDateTime(p.at)}</b><span>${escapeHtml(p.ip)} · ${escapeHtml(p.device || '')}</span></div>` : ''}
      <table class="rtable log-table">
        <thead><tr><th>시각</th><th>IP</th><th>기기</th></tr></thead>
        <tbody>${keys.map(k => {
          const r = all[k];
          return `<tr class="${k === myKey ? 'me' : ''}"><td class="num">${fmtDateTime(r.at)}${k === myKey ? ' <span class="badge accent">지금</span>' : ''}</td>
            <td class="num">${escapeHtml(r.ip || '')}</td><td>${escapeHtml(r.device || '')}</td></tr>`;
        }).join('')}</tbody>
      </table>
      <p class="small muted">교사 화면에 들어올 때마다 기록돼요 (최근 ${KEEP}개 보관). 모르는 시각이나 IP가 있으면 교사 계정 비밀번호를 바꾸세요.
      학교 안에서는 여러 기기가 같은 IP로 보일 수 있어요.</p>`;
  } catch (e) {
    console.error(e);
    body.innerHTML = '<p class="muted">기록을 읽지 못했어요. 보안 규칙에 teacherLog가 게시되었는지 확인해 주세요.</p>';
  }
}

document.getElementById('accessLogClose').addEventListener('click', () => document.getElementById('accessLog').close());
