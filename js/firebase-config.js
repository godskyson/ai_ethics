// Firebase 콘솔 > 프로젝트 설정 > 내 앱(웹)에 나오는 값
// 웹페이지에 공개되는 값이다. 데이터 보호는 database.rules.json(보안 규칙)이 맡는다.
export const firebaseConfig = {
  apiKey: "AIzaSyBJCyhyytNVWYWoV8rNrhEnml17W1FBy90",
  authDomain: "ai-ethics-3bb57.firebaseapp.com",
  databaseURL: "https://ai-ethics-3bb57-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "ai-ethics-3bb57",
  storageBucket: "ai-ethics-3bb57.firebasestorage.app",
  messagingSenderId: "952653528178",
  appId: "1:952653528178:web:a29b2bd42322e5451116eb"
};

// 교사 계정 이메일 (database.rules.json의 이메일과 같아야 한다)
export const TEACHER_EMAIL = 'king03603@gmail.com';
