# 설계 계획서 — 인공지능 텍스트 분류 · 윤리 수행평가 사이트

> 버전 0.2 (2026-11-04) · 상태: 결정 사항 반영 완료, 구현 대기
> Firebase 프로젝트: `ai-ethics-3bb57` (수행평가 전용)
> 요구사항 요약과 작업 규칙은 `CLAUDE.md`에 있다. 이 문서는 **어떻게 만들지**를 정한다.

---

## 1. 목표와 범위

### 1.1 목표
1. 학생이 텍스트 분류 모델을 직접 만들고(이름 → 데이터 → 학습 → 테스트), 테스트 결과 3개를 근거로 인공지능 윤리 주의점 3가지를 서술해 제출한다.
2. 교사는 한 화면에서 평가 시작과 종료, 학생별 진행 상황과 화면 이탈을 실시간으로 확인하고, 종료 시점의 결과를 보관하고 내보낸다.
3. 학생 계정은 학번과 숫자 4자리 비밀번호로 관리하고, 교사가 등록과 비밀번호 초기화를 맡는다. **학생 이름은 저장하지 않는다** (개인정보 최소 수집).

### 1.2 범위에 넣지 않는 것 (v1)
- 학생 이름 저장 (학번만 쓴다. 교사는 CSV를 내려받아 자체 명단과 맞춘다)
- 제한 시간 타이머 (교사가 `평가 종료`를 눌러 끝낸다)
- 자동 채점과 루브릭 점수 입력 (교사가 CSV로 내보내 따로 채점한다)
- 여러 교사 계정, 여러 평가의 동시 진행 (평가는 한 번에 하나만 진행한다)
- 학생이 만든 모델을 다른 학생과 공유하는 기능
- 오프라인 모드

---

## 2. 시스템 구성

```
┌────────────── GitHub Pages (정적) ──────────────┐
│ index.html (학생)            teacher.html (교사) │
│   ├ js/student.js              ├ js/teacher.js    │
│   ├ js/classifier.js           ├ js/roster.js     │
│   └ js/common.js  ←── 공통 ──→ ├ js/results.js    │
│     js/exam.js, presence.js     └ js/detail.js     │
└──────────────┬──────────────────────┬────────────┘
               │ Firebase JS SDK 10.12.2 (ES module)
       익명 Auth│                      │이메일/비밀번호 Auth
               ▼                      ▼
        ┌────────── Firebase Realtime Database ──────────┐
        │ exam · roster · pins · claims · progress ·      │
        │ presence · results     (database.rules.json)    │
        └─────────────────────────────────────────────────┘
```

- 분류 모델 학습과 예측은 학생 브라우저에서만 한다. DB에는 학습 데이터와 테스트 결과만 저장한다.
- 서버 코드(Cloud Functions)는 쓰지 않는다. 권한 검사는 모두 **보안 규칙**이 맡는다. 무료 Spark 요금제로 운영할 수 있다.

### 2.1 파일 구조

| 파일 | 역할 |
|---|---|
| `index.html` | 학생 화면의 마크업. 화면(section)마다 `data-screen` 속성을 단다 |
| `teacher.html` | 교사 화면의 마크업 |
| `css/style.css` | 디자인 토큰과 공통 컴포넌트 (참고 원본에서 옮김) |
| `css/teacher.css` | 대시보드 전용 레이아웃 |
| `js/firebase-config.js` | 웹 설정값 export |
| `js/firebase.js` | 앱 초기화. `db`, `auth`, 서버 시간 보정값(`serverNow()`) export |
| `js/common.js` | `hashPin()`, `isValidSid()`, `classOf()`, `fmtTime()`, `debounce()` |
| `js/classifier.js` | `tokenize()`, `train()`, `predict()` (참고 원본과 같은 알고리즘) |
| `js/student.js` | 학생 상태 머신, 화면 전환, 자동 저장, 이탈 감지 |
| `js/exam.js` | 학생 평가 1~5단계, 자동 저장, 제출·수정 |
| `js/presence.js` | 학생 접속·이탈·붙여넣기 기록 |
| `js/teacher.js` | 교사 로그인, 평가 제어, 대시보드 구독과 렌더링, 비밀번호 초기화 |
| `js/detail.js` | 학생 상태 계산(makeRow)과 상세 창. 대시보드와 결과 보기가 함께 씀 |
| `js/roster.js` | 학생 등록(범위·붙여넣기·한 명)과 삭제 |
| `js/results.js` | 결과 스냅샷 회차별 보기, CSV 생성, 결과 삭제 |
| `database.rules.json` | 보안 규칙 |
| `README.md` | 교사용 설치·운영 안내 |

---

## 3. 식별자 규칙

- **학번 `sid`**: 숫자 5자리, `학년(1) + 반(2) + 번호(2)` 형식. 예: `20301`은 2학년 3반 1번이다.
  - `isValidSid(s) = /^[1-3](0[1-9]|1[0-9])(0[1-9]|[1-4][0-9])$/`
  - `classOf(sid)`는 `"2-3"`을 돌려준다 (화면 표시와 필터에 쓴다).
- **비밀번호 `pin`**: 숫자 정확히 4자리, `/^\d{4}$/`.
- **비밀번호 해시**: `hashPin(sid, pin) = hex(SHA-256("ai_ethics:" + sid + ":" + pin))`. 학번을 솔트로 써서 같은 비밀번호라도 학생마다 해시가 다르다.
- **평가 회차 `examId`**: 평가를 시작할 때 만든다. 형식은 `YYYYMMDD-HHmmss` (예: `20261110-090512`). 같은 ID의 결과가 이미 있으면 종료할 때 `-2`, `-3`을 붙인다.

---

## 4. 데이터 모델

```jsonc
{
  "exam": {
    // 평가 상태는 학급마다 따로 있다 (2026-11-25 변경: 학급별로 평가 시간이 다르므로)
    "classes": {
      "2-3": {
        "status": "ready",        // "ready" | "running" | "ended" (값이 없으면 ready로 본다)
        "examId": "20261110-090512",
        "startedAt": 0, "endedAt": 0,  // serverTimestamp
        "resultId": "2-3_20261110-090512"  // 종료할 때 저장한 결과의 ID
      }
    },
    "minChars": 50               // 윤리 서술 최소 글자 수 (모든 학급 공통)
  },
  "roster": {
    "20301": { "classId": "2-3", "addedAt": 0 }   // 이름은 저장하지 않는다
  },
  "pins": {
    "20301": { "hash": "<hex>", "mustChange": true, "updatedAt": 0 }
  },
  "claims": {
    "<anonUid>": { "sid": "20301", "hash": "<hex>", "at": 0 }
  },
  "progress": {
    "20301": {
      "step": 3,                // 0 대기 · 1 이름 · 2 데이터 · 3 학습 · 4 테스트 · 5 서술 · 6 제출 완료
      "modelName": "감정 분류기",
      "dataset": [ { "label": "긍정", "texts": ["...", "..."] } ],
      "trainedAt": 0,
      "tests": [ { "text": "...", "top": "긍정", "probs": [ { "label": "긍정", "prob": 0.82 }, { "label": "부정", "prob": 0.18 } ] } ],
      // probs는 배열이다: 클래스 이름에 Firebase 키 금지 문자(. $ # [ ] /)가 들어갈 수 있어서 (M3에서 변경)
      "ethics": { "privacy": "", "bias": "", "judgment": "" },
      "submitted": false, "submittedAt": 0,
      "submitCount": 0,         // 제출 횟수 (수정 후 다시 제출하면 늘어난다)
      "updatedAt": 0
    }
  },
  "presence": {
    "20301": {
      "online": true, "state": "focused",   // "focused" | "away"
      "awayCount": 2, "lastAwayAt": 0, "awayMs": 0,
      "pasteCount": 1, "lastSeen": 0
    }
  },
  "results": {
    "2-3_20261110-090512": {     // 결과 ID = 학급_회차 (겹치면 -2, -3을 붙인다)
      "meta": { "classId": "2-3", "examId": "20261110-090512", "startedAt": 0, "endedAt": 0, "count": 30 },
      "students": { "20301": { "classId": "2-3", "progress": {}, "presence": {} } }  // 그 학급 학생만
    }
  }
}
```

**크기 제한** (규칙의 `.validate`와 클라이언트에서 함께 검사한다)

| 항목 | 제한 |
|---|---|
| 모델 이름 | 1~30자 |
| 클래스 수 | 2~6개 |
| 클래스 이름 | 1~20자 |
| 클래스별 문장 수 | 5~30개 |
| 문장 길이 | 1~100자 |
| 테스트 문장 | 정확히 3개, 1~100자 |
| 윤리 서술 | 항목마다 `minChars`~1000자 |

---

## 5. 인증과 보안 규칙

### 5.1 학생 로그인 순서
1. `signInAnonymously()`로 `uid`를 받는다 (같은 브라우저라면 유지된다).
2. 입력한 학번과 비밀번호로 `hash = hashPin(sid, pin)`을 계산한다.
3. `set(claims/{uid}, {sid, hash, at})`를 보낸다. 규칙이 `pins/{sid}/hash`와 비교해서 다르면 거부한다.
   - 거부되면 "학번 또는 비밀번호가 맞지 않아요"를 보여 준다. 등록되지 않은 학번과 비밀번호 오류를 구분해서 알려 주지 않는다.
4. 쓰기가 성공하면 `pins/{sid}/mustChange`를 확인한다. 이 경로는 본인만 읽을 수 있으며, `hash`는 읽지 않는다.
5. `mustChange`가 `true`면 비밀번호 변경 화면으로 간다. 아니면 내 학급의 `exam/classes/{학급}/status`에 따라 대기 화면이나 평가 화면으로 간다.

### 5.2 비밀번호 변경 (한 번의 multi-path update)
```js
update(ref(db), {
  [`pins/${sid}`]:   { hash: newHash, mustChange: false, updatedAt: serverTimestamp() },
  [`claims/${uid}`]: { sid, hash: newHash, at: serverTimestamp() }
});
```
- 새 비밀번호가 `0000`인지, 확인 입력과 같은지는 클라이언트에서 검사한다.
- 비밀번호가 바뀌면 다른 기기에 남아 있던 claim은 해시가 맞지 않게 되어 자동으로 무효가 된다.

### 5.3 교사의 비밀번호 초기화
`set(pins/{sid}, { hash: hashPin(sid,'0000'), mustChange: true })`를 쓴다. 이렇게 하면 그 학생의 기존 로그인 세션이 모두 무효가 된다.
무효가 된 학생은 스스로 오프라인을 기록할 수 없으므로, 같은 update에서 `presence/{sid}/online: false`도 함께 쓴다 (M5에서 추가).

### 5.4 보안 규칙 초안 (`database.rules.json`)

> **실제 규칙은 저장소의 `database.rules.json`이 기준이다.** M1에서 아래 초안을 다음과 같이 고쳤다.
> - 교사 이메일 `king03603@gmail.com`을 넣었다.
> - `pins/$sid`: 학생은 삭제할 수 없다(`newData.exists()`). `roster` 존재 확인은 `newData` 기준으로 바꿨다. 교사가 학생을 등록할 때 roster와 pins를 한 번에 쓰기 때문이다.
> - `roster/$sid`: 학번 형식을 정규식으로 검사한다.
> - `presence/$sid`: 본인이 읽을 수 있게 했다. `awayCount` transaction은 값을 먼저 읽어야 하기 때문이다.
> - `progress/$sid`: 모델 이름, 데이터셋, 테스트, 윤리 서술의 길이와 개수를 `.validate`로 검사한다.

```jsonc
{
  "rules": {
    // 교사 판별: auth.token.email === 'TEACHER_EMAIL' (실제 이메일로 바꾼다)
    "exam": {
      ".read": "auth != null",
      ".write": "auth != null && auth.token.email === 'TEACHER_EMAIL'"
    },
    "roster": {
      ".read": "auth != null && auth.token.email === 'TEACHER_EMAIL'",
      ".write": "auth != null && auth.token.email === 'TEACHER_EMAIL'",
      "$sid": {
        ".read": "auth != null && root.child('claims/' + auth.uid + '/sid').val() === $sid"
      }
    },
    "pins": {
      "$sid": {
        // 해시는 아무도 읽지 못한다. mustChange만 본인이 읽는다.
        "mustChange": {
          ".read": "auth != null && root.child('claims/' + auth.uid + '/sid').val() === $sid"
        },
        ".write": "auth != null && (auth.token.email === 'TEACHER_EMAIL' || (root.child('claims/' + auth.uid + '/sid').val() === $sid && root.child('claims/' + auth.uid + '/hash').val() === data.child('hash').val()))",
        ".validate": "newData.hasChildren(['hash','mustChange']) && newData.child('hash').isString() && newData.child('hash').val().length === 64 && root.child('roster/' + $sid).exists()"
      }
    },
    "claims": {
      ".read": "auth != null && auth.token.email === 'TEACHER_EMAIL'",
      "$uid": {
        ".read": "auth != null && auth.uid === $uid",
        ".write": "auth != null && auth.uid === $uid",
        // newData 기준 루트로 비교한다 (비밀번호 변경 multi-path update를 허용하기 위해)
        ".validate": "newData.hasChildren(['sid','hash']) && newData.parent().parent().child('pins/' + newData.child('sid').val() + '/hash').val() === newData.child('hash').val()"
      }
    },
    "progress": {
      ".read": "auth != null && auth.token.email === 'TEACHER_EMAIL'",
      ".write": "auth != null && auth.token.email === 'TEACHER_EMAIL'",
      "$sid": {
        ".read": "auth != null && root.child('claims/' + auth.uid + '/sid').val() === $sid",
        ".write": "auth != null && root.child('claims/' + auth.uid + '/sid').val() === $sid && root.child('claims/' + auth.uid + '/hash').val() === root.child('pins/' + $sid + '/hash').val() && root.child('exam/classes/' + root.child('roster/' + $sid + '/classId').val() + '/status').val() === 'running'"
      }
    },
    "presence": {
      ".read": "auth != null && auth.token.email === 'TEACHER_EMAIL'",
      ".write": "auth != null && auth.token.email === 'TEACHER_EMAIL'",
      "$sid": {
        ".write": "auth != null && root.child('claims/' + auth.uid + '/sid').val() === $sid && root.child('claims/' + auth.uid + '/hash').val() === root.child('pins/' + $sid + '/hash').val()"
      }
    },
    "results": {
      ".read": "auth != null && auth.token.email === 'TEACHER_EMAIL'",
      ".write": "auth != null && auth.token.email === 'TEACHER_EMAIL'"
    }
  }
}
```

> 구현할 때 Rules Playground로 `newData.parent().parent()` 비교가 multi-path update에서 의도대로 동작하는지 가장 먼저 확인한다 (§10 M1). 의도대로 동작하지 않으면 claim 갱신을 비밀번호 변경 직후의 두 번째 쓰기로 나눈다.

**알려진 한계**
- 비밀번호가 4자리라서 1만 번 시도하면 뚫린다. 수업 시간 안에서 쓰는 수준의 보호로 보고, README에 적는다.
- `0000` 재사용 금지는 클라이언트에서만 검사한다.

---

## 6. 학생 화면 설계

### 6.1 상태 머신

```
[login] ──성공──▶ (mustChange?) ──예──▶ [changePin] ──▶ ┐
                         └──아니오──────────────────────┤
                                                        ▼
      내 학급 status: ready ──▶ [waiting]
                                  running ─▶ [step 1..5] ──제출──▶ [done]
                                  ended ───▶ [ended]
```
- 내 학급의 `exam/classes/{학급}/status`를 `onValue`로 구독해서 값이 바뀔 때마다 상태를 다시 결정한다.
- `progress/{sid}/step`과 `submitted` 값을 읽어 이어 하기 위치를 정한다. `submitted`가 참이면 `[done]`으로 간다.
- **제출 후 수정**: 평가가 `running`인 동안에는 `[done]`에서 `수정하기`를 눌러 1~5단계로 돌아갈 수 있다. 이때 `submitted:false`가 되고, 다시 제출해야 제출 완료로 표시된다. 다시 제출하지 않아도 마지막 저장본은 종료 스냅샷에 남는다.

### 6.2 화면별 명세

| 화면 | 주요 요소 | 검사와 동작 |
|---|---|---|
| login | 학번 입력(숫자 키패드 `inputmode="numeric"`), 비밀번호 4자리(`type=password`, `maxlength=4`), 로그인 버튼 | 형식 오류는 즉시 표시한다. 실패하면 흔들림 애니메이션과 메시지를 보여 준다 |
| changePin | 새 비밀번호와 확인 입력, 안내 박스("꼭 기억하세요. 잊으면 선생님께 초기화를 요청하세요") | 4자리가 아니거나, 확인과 다르거나, `0000`이면 거부한다 |
| waiting | 학번과 반, "선생님이 평가를 시작할 때까지 기다려 주세요", 로그아웃 버튼 | presence `online`만 기록한다 |
| 1 모델 이름 | 참고 원본의 1단계와 같다 | 1~30자 |
| 2 데이터 입력 | 클래스 카드(이름과 쉼표로 구분한 문장), 클래스 추가와 삭제 | 클래스 2~6개, 클래스마다 문장 5개 이상. 기본 예시 데이터는 넣지 않는다 (평가이므로 빈 카드 2개로 시작한다) |
| 3 학습 | 진행률 막대와 학습 애니메이션 | 학습이 끝나면 `trainedAt`을 저장하고 자동으로 4단계로 간다 |
| 4 테스트 | (a) 자유 테스트 입력과 결과 막대 (b) **제출용 테스트 1·2·3** 칸마다 "분류하기" 버튼과 결과. 문장 내용에는 조건을 두지 않는다 (안내 문구: "윤리 서술의 근거로 쓰고 싶은 문장을 자유롭게 넣어 보세요") | 3개를 모두 분류해야 다음으로 넘어간다. 문장을 고치면 결과가 무효가 되어 다시 분류해야 한다. 데이터를 바꾸려고 2단계로 돌아가면 테스트 결과를 다시 계산하라고 안내한다 |
| 5 윤리 서술 | 위쪽에 테스트 3개의 결과 요약 카드, 아래에 서술칸 3개(개인정보 / 편향 / 판단)와 항목별 도움 질문, 글자 수 표시 | 항목마다 50자(`minChars`) 이상이어야 한다. 제출 버튼을 누르면 확인 모달("제출할까요? 평가가 끝나기 전까지는 다시 수정할 수 있어요")을 띄운다 |
| done | "제출 완료", 제출 시각, 내 답안 읽기 전용 보기, `수정하기` 버튼 | `수정하기`를 누르면 `submitted:false`로 바꾸고 5단계로 간다 (스텝퍼로 1~4단계에도 갈 수 있다) |
| ended | "평가가 종료되었습니다", 저장된 마지막 단계 안내 | 모든 입력을 비활성화한다 |

**5단계 도움 질문 (예시 문구)**
- 개인정보: "학습 데이터나 테스트 문장에 이름, 연락처, 학교 같은 정보가 들어가면 어떤 문제가 생길까요?"
- 편향: "학습 데이터가 한쪽으로 치우치면 테스트 결과가 어떻게 달라졌나요? 내 모델의 결과에서 찾아보세요."
- 판단: "확률이 낮거나 틀린 결과가 나온 문장이 있었나요? 인공지능의 판단을 그대로 믿으면 어떤 위험이 있을까요?"

### 6.3 자동 저장
- `saveProgress(patch)`: `update(progress/{sid}, {...patch, updatedAt})`를 실행한다. 글 입력은 2초 디바운스를 건다. 단계를 바꿀 때와 학습이 끝났을 때는 즉시 저장한다.
- 쓰기가 거부되면(평가 종료나 제출 후) 상태를 다시 읽어 화면을 맞춘다.
- 저장 상태를 화면 구석에 작게 표시한다: "저장됨 · 09:12:30" 또는 "저장 중…" 또는 "연결 끊김 — 다시 연결되면 저장돼요".

### 6.4 이탈 감지
- `document.visibilitychange`(hidden)나 `window.blur`가 생기면 `state:'away'`로 쓰고, `awayCount`를 1 늘리고(`increment()` 사용. 값을 먼저 읽을 필요가 없다), `lastAwayAt`을 기록한다. 구현은 `js/presence.js`.
- 횟수와 시간은 내 학급의 평가 상태가 `running`일 때만 누적한다. 대기 화면에서는 `state`만 갱신한다.
- `visible`이나 `focus`가 돌아오면 `state:'focused'`로 쓰고, 이탈해 있던 시간을 `awayMs`에 더한다.
- blur와 visibilitychange가 함께 발생해도 한 번만 세도록 300ms 안의 중복 이벤트는 합친다.
- 30초마다 `lastSeen`을 갱신해서 교사 화면이 "응답 없음"을 판단하는 데 쓴다.
- `onDisconnect().update({online:false, lastSeen: serverTimestamp()})`.
- `paste` 이벤트가 생기면 `pasteCount`를 1 늘린다. 막지는 않는다.

---

## 7. 교사 화면 설계

### 7.1 레이아웃 (1280px 이상)

```
┌ 헤더: 평가 제목 · [로그아웃]                                                         ┐
├ 학급 막대: 평가 학급 [선택] · 상태 배지 · 경과 시간 · [평가 시작] [평가 종료] [다시 평가 준비] ┤
│           학급별 상태 칩 (1-1반 진행 중 · 2-3반 대기 …) — 누르면 그 학급 선택          │
├ 요약 줄: 전체 32 · 접속 30 · 이탈 중 2 · 단계별 막대(1▮2▮3▮4▮5▮완료) · 제출 12       ┤
├ 탭: [대시보드] [명단 관리] [결과 보기]                                              ┤
│ 대시보드: 반 필터 · 정렬(학번/단계/이탈 횟수) · 이탈 중인 학생만 보기 토글           │
│  ┌ 학생 카드 그리드 ─────────────────────────────────────────────┐                  │
│  │ 20301 (2-3)   ● 온라인 · 집중  [■■■□□□] 3단계  이탈 2 · 붙여넣기 1 │ [상세] [초기화]│
│  └───────────────────────────────────────────────────────────────┘                  │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

- 카드 색 상태: 이탈 중이면 빨간 테두리와 깜박이는 점(움직임 줄이기 설정 시 깜박이지 않는다), 오프라인이면 회색, 제출 완료면 초록 체크, 제출 후 수정 중이면(`submitCount > 0`이고 `submitted:false`) "수정 중" 배지.
- "응답 없음": `online`이 참인데 `lastSeen`이 90초 넘게 지난 경우 노란 경고를 띄운다.
- 구독 경로: `roster`, `progress`, `presence`, `exam` 4개를 `onValue`로 구독하고 sid 기준으로 합쳐서 그린다. 50명 정도라면 경로마다 구독 하나씩으로 충분하다.

### 7.2 평가 제어
| 동작 | 처리 |
|---|---|
| 평가 학급 | 버튼은 **선택한 학급에만** 적용된다. '전체 보기'에서는 버튼이 잠긴다. 요약과 학생 카드도 선택한 학급만 보여 준다. 마지막 선택은 브라우저에 기억한다 |
| 평가 시작 | 그 학급이 `ready`일 때만. `exam/classes/{학급}`에 새 `examId`, `status:'running'`, `startedAt`을 쓴다. 다른 학급 학생은 계속 대기 화면 |
| 평가 종료 | 확인 모달을 띄운다. 그 학급 학생의 `progress`, `presence`를 `results/{학급}_{examId}`에 스냅샷으로 저장한 뒤 그 학급만 `status:'ended'`로 바꾼다. 스냅샷 저장이 실패하면 상태를 바꾸지 않는다 |
| 다시 평가 준비 | 그 학급이 `ended`일 때만. 확인을 받고 **그 학급 학생의** `progress`와 `presence`만 지운 뒤 `status:'ready'`로 바꾼다 (다른 학급, 명단, 비밀번호, 결과는 남긴다) |

제한 시간 타이머는 두지 않는다. 헤더의 경과 시간은 참고용으로만 표시한다.

### 7.3 명단 관리
- 반 목록은 `classOf(sid)`로 만든다. 반을 따로 저장하지 않고 학번에서 계산한다.
- 한 명씩 추가: 학번을 입력하면 `roster/{sid}`와 `pins/{sid}`(0000 해시, `mustChange:true`)를 한 번의 update로 함께 쓴다.
- 일괄 추가: 텍스트 영역에 학번을 붙여넣는다 (줄바꿈, 쉼표, 공백, 탭 모두 구분자로 인정한다). 엑셀의 학번 열을 그대로 복사해 붙여넣을 수 있다. 미리보기 표에서 형식 오류와 중복을 표시한 뒤 확정한다.
- 반 단위 빠른 추가: 학년, 반, 시작 번호, 끝 번호를 입력하면 `20301~20330`처럼 학번을 한 번에 만든다.
- 삭제: `roster`, `pins`, `progress`, `presence`에서 해당 sid를 지운다. 확인을 받는다.
- 비밀번호 초기화: §5.3. 성공하면 "20301 비밀번호를 0000으로 초기화했어요"라는 토스트를 띄운다.

### 7.4 결과 보기와 CSV
- `results` 목록(회차별)을 보여 주고, 회차를 고르면 학생별 표를 보여 준다. 표 안에서 서술 원문을 펼쳐 볼 수 있다.
- CSV 열: `학번, 반, 최종단계, 제출여부, 제출시각, 제출횟수, 모델이름, 클래스목록, 테스트1, 결과1, 테스트2, 결과2, 테스트3, 결과3, 개인정보, 편향, 판단, 이탈횟수, 이탈시간(초), 붙여넣기횟수`.
- UTF-8에 BOM을 붙이고, 셀 안의 따옴표와 줄바꿈은 이스케이프한다. 파일 이름은 `ai_ethics_{결과 ID}.csv`.

---

## 8. 분류기 모듈 (`js/classifier.js`)

참고 원본의 코드를 그대로 옮기고 ES module로 export만 한다.

```js
export function tokenize(text)          // 'w:단어', 'c:글자', 'b:2글자' 토큰
export function train(dataset)          // [{label, texts}] → model
export function predict(model, text)    // → [{label, color, prob}] (확률 내림차순)
```
- 모델 객체는 DB에 저장하지 않는다. 새로고침하면 `progress.dataset`으로 다시 학습한다. 몇 밀리초면 끝난다.
- 확률은 소수 셋째 자리까지만 저장한다.

---

## 9. 디자인 시스템

- 토큰: 참고 원본의 `:root` 변수(`--ink`, `--paper`, `--surface`, `--field`, `--accent`, `--ok`, `--c0~5`, `--line`, `--shadow*`, `--ease-out`)를 그대로 쓴다. 상태 색 3개를 더한다: `--warn: #ffb37a`, `--danger: #ff6b6b`, `--offline: #b8bbc2`.
- 컴포넌트: 버튼, 입력, 스텝퍼, 카드, 모달, 토스트, 배지. `style.css`에 한 번만 정의하고 두 화면이 함께 쓴다.
- 스텝퍼는 5칸이다: 이름 · 데이터 · 학습 · 테스트 · 윤리 서술.
- 다크 모드는 v1에서 지원하지 않는다 (교실 프로젝터 기준으로 밝은 화면 하나만 만든다).

---

## 10. 구현 단계 (마일스톤)

| 단계 | 내용 | 완료 기준 |
|---|---|---|
| **M0** 준비 (교사) | ~~Firebase 프로젝트 생성~~ (`ai-ethics-3bb57` 완료), Realtime DB(asia-southeast1) 생성, 익명 로그인과 이메일 로그인 활성화, 교사 계정 생성, 웹 앱 등록 후 설정값 전달 | `firebase-config.js`에 넣을 값과 교사 이메일 확보 |
| **M1** 기반 | 파일 구조, `style.css`, `firebase.js`, `common.js`, `classifier.js`, 규칙 초안 배포, 규칙 플레이그라운드 검증 | 해시 비교 로그인 규칙과 multi-path update 동작 확인 |
| **M2** 학생 인증 | 로그인, 비밀번호 변경, 대기 화면, 로그아웃 | 시나리오 1·5 통과 |
| **M3** 학생 평가 | 1~5단계, 자동 저장, 이어 하기, 제출, 종료 화면 | 시나리오 2·4 통과 |
| **M4** 이탈 감지 | presence, onDisconnect, 이탈과 붙여넣기 카운트 | 시나리오 3 통과 |
| **M5** 교사 대시보드 | 교사 로그인, 평가 제어, 요약 줄, 카드 그리드, 학생 상세 | 학생 2명 동시 진행이 실시간으로 반영됨 |
| **M6** 명단·결과 | 명단 관리(일괄 추가 포함), 초기화, 종료 스냅샷, 결과 보기, CSV | 시나리오 6 통과, CSV를 엑셀로 열어 한글 확인 |
| **M7** 마무리 | README(교사 안내), 접근성 점검, 모바일 폭 점검, GitHub Pages 배포 | 배포 주소에서 전체 시나리오 통과 |

시나리오 번호는 `CLAUDE.md` §7을 따른다.

---

## 11. 위험 요소와 대응

| 위험 | 대응 |
|---|---|
| 수업 중 네트워크가 끊김 | Firebase 오프라인 캐시가 쓰기를 모아 두었다가 다시 연결되면 보낸다. 화면에 연결 상태를 표시한다 |
| 학생이 다른 기기에서 다시 로그인 | 같은 비밀번호라면 허용한다 (claim이 2개가 된다). 교사 상세 화면에 접속 기기 수를 표시한다 |
| 친구 비밀번호를 알고 대리 로그인 | 막을 수 없다. 이탈 기록과 접속 기기 수를 교사가 참고한다 |
| 종료 순간에 쓰던 글이 유실됨 | 디바운스를 2초로 짧게 둔다. 종료 신호를 받으면 학생 화면이 마지막 저장을 시도한다 (규칙 때문에 거부될 수 있음을 받아들인다) |
| 무료 요금제 동시 접속 한도(100) | 한 반 30명 규모라면 충분하다. 여러 반이 동시에 진행할 때만 주의한다 |

---

## 12. 결정 사항 (2026-11-04 확정)

| # | 질문 | 결정 |
|---|---|---|
| 1 | 학번 형식과 이름 | 5자리(학년·반·번호), **학번만** 저장하고 이름은 저장하지 않는다 |
| 2 | 윤리 서술 최소 글자 수 | 항목마다 **50자** |
| 3 | 제출 후 수정 | 평가가 **종료되기 전까지 학생이 자유롭게** 수정하고 다시 제출할 수 있다 |
| 4 | 제한 시간 | **두지 않는다**. 교사가 직접 종료한다 |
| 5 | 테스트 문장 조건 | **조건 없이 자유롭게** 입력한다 |
| 6 | Firebase 프로젝트 | 새 프로젝트 **`ai-ethics-3bb57`** |

### 남은 준비 (M0, 교사가 콘솔에서 할 일)
- Realtime Database 생성 (위치: asia-southeast1 권장)
- Authentication에서 `익명`과 `이메일/비밀번호` 로그인 활성화
- 교사 계정 생성 (이메일만 알려 주고, 비밀번호는 알려 주지 않는다)
- 프로젝트 설정에서 웹 앱을 등록하고 `firebaseConfig` 값 전달
