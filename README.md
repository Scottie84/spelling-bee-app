# SnapQuiz — 초등학생용 사진 영단어 퀴즈

영어 단어책을 사진으로 찍으면 단어를 자동으로 추출하고, 누적 저장된 단어장에서
**4지선다 객관식 퀴즈**를 무작위로 출제하는 모바일 우선 웹앱입니다.

> 자세한 제품 요구사항은 [`spellingbee prd.md`](spellingbee%20prd.md)를 참고하세요.

## 주요 기능

- 📷 **사진 → 단어 자동 등록**: OpenRouter 비전 모델로 단어·뜻·예문·유의어/반의어 추출
- 📚 **단어장 누적 저장**: Supabase(`english_words` 테이블) 우선, 미설정 시 IndexedDB/localStorage 폴백, 그룹별 관리
- 🎮 **4지선다 퀴즈**: 뜻↔단어, 빈칸 채우기, 유의어/반의어 (유형 자동 혼합)
- 🔁 **복습 모드**: 틀린 단어 자동 추적, 복습만 풀기
- 📤 **내보내기/가져오기**: 단어장 JSON 백업
- ♿ 큰 글씨·큰 버튼, 키보드/스크린리더 접근성, 즉시 피드백

## 구성

| 파일 | 설명 |
|---|---|
| `engine.js` | 클라이언트 엔진 — 저장소(Supabase/IndexedDB/localStorage)·퀴즈 생성·채점·이미지 추출 (브라우저/Node 공용) |
| `index.template.html` | 단일 페이지 UI 템플릿 (`__OPENROUTER_API_KEY__` 플레이스홀더 포함) |
| `build.py` | 템플릿 + 엔진 + API 키를 인라인해 `index.html` 빌드 |
| `config.py` / `openrouter_client.py` | Python용 OpenRouter 설정·클라이언트 (스모크 테스트) |
| `engine.test.mjs` / `qa.test.mjs` | 단위 테스트 + Playwright 종합 QA 테스트 |

## 로컬 실행

```bash
# 1. API 키 설정
cp .env.example .env          # OPENROUTER_API_KEY 를 채워 넣으세요

# 2. index.html 빌드 (키를 인라인)
python build.py

# 3. 빌드된 index.html 을 브라우저에서 열기 (file:// 로 동작, 서버 불필요)
```

> ⚠️ `index.html`은 API 키를 포함하므로 git에 커밋되지 않습니다(`.gitignore`).
> 키는 오직 `.env` 에만 두고, 절대 코드/저장소에 하드코딩하지 마세요.

## 데이터 저장 (Supabase)

단어장은 Supabase의 `english_words` 테이블에 저장됩니다. `.env`(로컬) 또는 Vercel
환경변수에 `SUPABASE_URL`과 `SUPABASE_ANON_KEY`(publishable/anon 키)를 설정하면
`engine.js`가 자동으로 Supabase를 저장소로 사용합니다. 두 값은 공개되어도 안전하며
(데이터는 Row Level Security로 보호), 미설정 시 IndexedDB/localStorage로 폴백합니다.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `id` | text (PK) | 클라이언트 생성 ID (`w_xxxxxx`) |
| `word` / `pos` / `meaning` / `example` / `syn` / `ant` | text | 단어 데이터 |
| `group_name` | text | 그룹 이름 |
| `added_at` | timestamptz | 추가 시각 |
| `stats` | jsonb | `{ seen, correct, wrong }` |

> 이 앱은 로그인 기능이 없어 anon 키에 전체 읽기/쓰기 권한을 부여하는 RLS 정책을
> 사용합니다(기존 테이블과 동일한 신뢰 모델). 인증이 필요하면 정책을 강화하세요.

## 테스트

```bash
node engine.test.mjs          # 퀴즈 로직 단위 테스트 + 실제 추출 1회
npm install && node qa.test.mjs   # Playwright 기반 전체 QA (먼저 build.py 실행)
```
