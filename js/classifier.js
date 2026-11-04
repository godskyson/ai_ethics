// 텍스트 분류 모델: 나이브 베이즈 (단어 + 글자 1·2-gram)
// 참고 원본(infoclass/text-classifier.html)과 같은 알고리즘이다. 결과가 같아야 하므로 계산 방식을 바꾸지 않는다.

export const COLORS = 6; // 클래스 색 개수 (--c0 ~ --c5)

// 쉼표로 구분한 문장 목록을 배열로 바꾼다
export function splitItems(text) {
  return text.split(',').map(s => s.trim()).filter(Boolean);
}

export function tokenize(text) {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const tokens = [];
  for (const w of words) {
    tokens.push('w:' + w);
    // 한국어는 조사·어미가 붙으므로 글자 단위 조각도 특징으로 사용
    for (let i = 0; i < w.length; i++) {
      tokens.push('c:' + w[i]);
      if (i < w.length - 1) tokens.push('b:' + w.slice(i, i + 2));
    }
  }
  return tokens;
}

// dataset: [{ label, texts: [문장, ...] }, ...]
export function train(dataset) {
  const vocab = new Set();
  const classes = dataset.map(({ label, texts }) => {
    const counts = new Map();
    let total = 0;
    for (const t of texts) {
      for (const tok of tokenize(t)) {
        counts.set(tok, (counts.get(tok) || 0) + 1);
        vocab.add(tok);
        total++;
      }
    }
    return { label, docs: texts.length, counts, total };
  });
  const totalDocs = classes.reduce((s, c) => s + c.docs, 0);
  return { classes, vocabSize: vocab.size, totalDocs };
}

// 반환값: [{ label, color, prob }, ...] 확률이 높은 순서
export function predict(m, text) {
  const toks = tokenize(text);
  const scores = m.classes.map(c => {
    let s = Math.log(c.docs / m.totalDocs);
    for (const tok of toks) {
      s += Math.log(((c.counts.get(tok) || 0) + 1) / (c.total + m.vocabSize));
    }
    return s;
  });
  // log 점수를 확률로 변환 (softmax)
  const max = Math.max(...scores);
  const exps = scores.map(s => Math.exp(s - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return m.classes
    .map((c, i) => ({ label: c.label, color: i % COLORS, prob: exps[i] / sum }))
    .sort((a, b) => b.prob - a.prob);
}

// DB에 저장할 형태로 바꾼다: { text, top, probs: [{ label, prob: 0.823 }, ...] } (확률은 소수 셋째 자리까지)
// 클래스 이름에 Firebase 키로 쓸 수 없는 문자(. $ # [ ] /)가 들어갈 수 있어서 객체가 아닌 배열로 저장한다.
export function toTestRecord(text, preds) {
  return {
    text,
    top: preds[0].label,
    probs: preds.map(p => ({ label: p.label, prob: Math.round(p.prob * 1000) / 1000 })),
  };
}

// 판단 근거: 테스트 문장의 조각 중 클래스 사이 확률 차이가 큰 조각 (참고 원본의 도움말과 같은 계산)
export function evidence(m, text, limit = 6) {
  return [...new Set(tokenize(text))]
    .filter(tok => !tok.startsWith('c:')) // 한 글자 조각은 너무 많아서 단어·두 글자 조각만 쓴다
    .map(tok => {
      const counts = m.classes.map(c => c.counts.get(tok) || 0);
      const ps = m.classes.map((c, i) => (counts[i] + 1) / (c.total + m.vocabSize));
      const sorted = [...ps].sort((a, b) => b - a);
      return { piece: tok.slice(2), counts, best: ps.indexOf(sorted[0]), strength: Math.log(sorted[0] / sorted[1]) };
    })
    .filter(r => r.counts.some(n => n > 0) && r.strength > 0.01)
    .sort((a, b) => b.strength - a.strength)
    .filter((r, i, arr) => arr.findIndex(o => o.piece === r.piece) === i) // '오늘'처럼 단어와 2글자 조각이 겹치면 하나만
    .slice(0, limit);
}
