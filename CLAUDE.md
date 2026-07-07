# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SpellingBee (구 SnapQuiz) — 초등학생용 영단어 퀴즈 모바일 웹앱. 단어책을 사진으로 찍으면 OpenRouter 비전 모델이 단어를 추출해 단어장에 저장하고, 4지선다 퀴즈를 출제한다. UI 텍스트는 모두 한국어. 제품 요구사항은 `spellingbee prd.md` 참고.

## Commands

```bash
python build.py            # index.html 빌드 (로컬용 — .env의 API 키를 인라인)
node build_vercel.mjs      # dist/index.html 빌드 (Vercel용 — 키 미포함, /api/extract 사용)

node engine.test.mjs       # 엔진 단위 테스트 + 라이브 추출 1회
node qa.test.mjs           # Playwright 전체 QA (먼저 python build.py 실행)
python main.py             # OpenRouter 연결 스모크 테스트
```

- 로컬 확인: 빌드된 `index.html`은 file:// 로도 열리고, `python -m http.server`로 서빙해도 된다.
- `engine.test.mjs`의 마지막 라이브 추출 테스트는 무료 비전 모델 스로틀링(429/504)으로 실패할 수 있다 — 유닛 테스트가 전부 통과하면 코드 문제가 아니다.

## Architecture

프레임워크/번들러 없는 단일 페이지 앱. 소스는 두 파일이고 빌드가 하나로 합친다:

- **`index.template.html`** — 전체 UI: CSS(디자인 토큰), 화면별 `<section class="screen">` 마크업, 화면 전환·이벤트 처리 컨트롤러 JS(파일 하단 인라인 `<script>`).
- **`engine.js`** — `window.SnapEngine` 전역 하나를 노출. 저장소, 퀴즈 생성(`buildQuiz`), 채점, 이미지 추출(`extractWordsFromImage`)·검증. 브라우저/Node 겸용: 퀴즈 로직은 순수 함수이고 영속 계층은 `init()`에서 감지해 교체된다 (Supabase → IndexedDB → localStorage → Node에서는 인메모리).

빌드는 템플릿의 `<script src="engine.js">`를 인라인으로 치환하고 플레이스홀더 4개를 주입한다: `__OPENROUTER_API_KEY__`, `__SUPABASE_URL__`, `__SUPABASE_ANON_KEY__`, `__POLY_PROBLEMS__`(← `poly_problems.json`, 폴리 스펠링비 고정 문제집).

**빌드가 두 갈래인 이유 (API 키 취급 차이):**

| | `build.py` → `index.html` | `build_vercel.mjs` → `dist/` |
|---|---|---|
| OpenRouter 키 | `.env`에서 읽어 클라이언트에 인라인 → 브라우저가 OpenRouter 직접 호출 | 빈 값 주입 → engine이 `/api/extract`·`/api/verify` 서버리스 함수로 폴백 (키는 Vercel 환경변수에만 존재) |
| 커밋 여부 | gitignore (키 포함) | gitignore (빌드 산출물) |

따라서 **추출 프롬프트나 비전 모델 목록(`VISION_MODELS`)을 바꿀 때는 `engine.js`와 `api/extract.js` 두 곳을 함께 수정**해야 한다 (검증은 `api/verify.js`). 무료 비전 모델은 심하게 스로틀링되므로 양쪽 모두 다중 패스 + 지수 백오프 재시도 체인을 갖고 있다.

**데이터**: 단어장은 Supabase `english_words` 테이블 (컬럼: id, word, pos, meaning, example, syn, ant, group_name, added_at, stats jsonb). anon 키에 전체 읽기/쓰기를 허용하는 RLS — 로그인 없는 신뢰 모델. Supabase 미설정 시 IndexedDB/localStorage 폴백.

## Deployment

GitHub `Scottie84/spelling-bee-app` ↔ Vercel 프로젝트 `spelling-bee-app-egu1` 연동:
- `main` 푸시 → 프로덕션 자동 배포 (https://spelling-bee-app-egu1.vercel.app)
- 다른 브랜치 푸시 → 프리뷰 배포

작업 흐름: 기능 브랜치에서 작업·검증 → 사용자 확인 후 main에 병합·푸시. Vercel 빌드는 `vercel.json`의 `node build_vercel.mjs`가 수행하므로 로컬 `dist/`나 `index.html`을 배포에 쓸 일은 없다.

## Editing rules

- UI/컨트롤러 수정은 `index.template.html`, 엔진 로직은 `engine.js`. 수정 후 `python build.py`로 재빌드해야 로컬 `index.html`에 반영된다. `index.html`을 직접 고치지 말 것.
- `engine.js`에 리터럴 `</script>`를 넣으면 인라인 빌드가 거부된다.
- `build_vercel.mjs`의 치환은 함수 치환을 쓴다 — engine.js 안의 `$&` 같은 시퀀스가 String.replace 특수 패턴으로 해석되는 사고를 막기 위함이니 유지할 것.
