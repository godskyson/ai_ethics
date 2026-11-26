// Firebase 초기화. 다른 모듈은 여기서 db, auth와 SDK 함수를 가져다 쓴다.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getDatabase, ref, get, set, update, remove, onValue, off, push,
  serverTimestamp, runTransaction, onDisconnect, increment,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import {
  getAuth, signInAnonymously, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  setPersistence, browserSessionPersistence,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { firebaseConfig } from './firebase-config.js';

export const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
export const auth = getAuth(app);

export {
  ref, get, set, update, remove, onValue, off, push, serverTimestamp, runTransaction, onDisconnect, increment,
  signInAnonymously, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  setPersistence, browserSessionPersistence,
};

// 서버 시간 보정: 기기 시계가 틀려도 교사·학생 화면이 같은 시각을 쓰게 한다
let offset = 0;
onValue(ref(db, '.info/serverTimeOffset'), s => { offset = s.val() || 0; });
export function serverNow() { return Date.now() + offset; }

// 연결 상태 구독. cb(true|false)
export function onConnection(cb) {
  return onValue(ref(db, '.info/connected'), s => cb(s.val() === true));
}

// 보안 규칙에 막힌 쓰기인지 확인
export function isPermissionDenied(err) {
  return err && /permission[_ -]denied/i.test(err.code || err.message || '');
}
