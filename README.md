# SnapQuiz — 초등학생용 사진 영단어 퀴즈

영어 단어책을 사진으로 찍으면 단어를 자동으로 추출하고, 누적 저장된 단어장에서
**4지선다 객관식 퀴즈**를 무작위로 출제하는 모바일 우선 웹앱입니다.

> 자세한 제품 요구사항은 [`spellingbee prd.md`](spellingbee%20prd.md)를 참고하세요.

## 주요 기능

- 📷 **사진 → 단어 자동 등록**: OpenRouter 비전 모델로 단어·뜻·예문·유의어/반의어 추출
- 📚 **단어장 누적 저장**: IndexedDB(미지원 시 localStorage) 기반, 그룹별 관리
- 🎮 **4지선다 퀴즈**: 뜻↔단어, 빈칸 채우기, 유의어/반의어 (유형 자동 혼합)
- 🔁 **복습 모드**: 틀린 단어 자동 추적, 복습만 풀기
- 📤 **내보내기/가져오기**: 단어장 JSON 백업
- ♿ 큰 글씨·큰 버튼, 키보드/스크린리더 접근성, 즉시 피드백

## 구성

| 파일 | 설명 |
|---|---|
| `engine.js` | 클라이언트 엔진 — 저장소·퀴즈 생성·채점·이미지 추출 (브라우저/Node 공용) |
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

## 테스트

```bash
node engine.test.mjs          # 퀴즈 로직 단위 테스트 + 실제 추출 1회
npm install && node qa.test.mjs   # Playwright 기반 전체 QA (먼저 build.py 실행)
```
