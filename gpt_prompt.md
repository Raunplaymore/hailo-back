이 문서는 `hailo-back` 프로젝트를 위한 메모/프롬프트 모음입니다.
- 1부: README 초안(현재 상태/향후 리팩토링 방향 정리)
- 2부: 멀티 프로젝트(Hailo-front/Hailo-camera) 연동을 위해 `Hailo-back`에 전달할 요청 프롬프트

---

# hailo-back

(Raspberry Pi Swing Upload & Analysis Server)

라즈베리파이에서 동작하는 **골프 스윙 영상 업로드 및 분석 백엔드 서버**입니다.
현재는 **업로드 + 정적 프론트 서빙** 중심의 경량 Express 서버이며,
향후 **비동기 스윙 분석 Job 서버**로 확장/리팩토링될 예정입니다.

기본 포트는 `3000`입니다.

---

## 🎯 역할 정의

### 현재 역할 (AS-IS)

* 스윙 영상 업로드 수신
* 업로드된 영상 파일 관리
* 정적 프론트엔드(`client-dist`) 서빙
* 분석 로직은 **스텁(stub)** 또는 간이 파이프라인

### 향후 역할 (TO-BE)

* 업로드 → **분석 Job 생성**
* Job 상태 관리 (`queued / running / succeeded / failed`)
* OpenCV / ML 기반 분석 파이프라인 연동
* 스윙 이벤트 / 템포 / (추후) 클럽 트래킹 결과 JSON 제공

---

## ▶️ 실행 방법

```bash
npm install
node server.js
```

라즈베리파이 환경에서 업로드 경로를 명시하려면:

```bash
UPLOAD_DIR=/home/ray/uploads node server.js
```

### 기본 설정

* 기본 포트: `3000`
* 기본 업로드 경로: `./uploads`

  * 디렉토리가 없으면 자동 생성
  * `UPLOAD_DIR` 환경변수로 변경 가능
* 프론트 빌드가 존재하면:

  * `http://localhost:3000/` 에서 접근 가능

---

## 🧱 기술 스택

* Node.js
* Express
* Multer (파일 업로드)
* PM2 (운영)
* Python(OpenCV/ML) 워커 연동 준비

---

## 🔌 API (현재 제공)

### 영상 업로드

```http
POST /api/upload
```

* `multipart/form-data`
* 필드명: `video`

응답 예시:

```json
{
  "ok": true,
  "file": "20240101_123456.mp4"
}
```

---

### 파일 목록 조회

```http
GET /api/files
```

응답:

```json
[
  "20240101_123456.mp4",
  "20240101_123789.mp4"
]
```

---

### 파일 삭제

```http
DELETE /api/files/:name
```

* 경로 이스케이프 방지 처리 적용
* 존재하지 않는 파일은 오류 반환

---

### 업로드된 영상 접근

```http
GET /uploads/:name
```

* 파일이 없으면 404

---

### 헬스 체크

```http
GET /health/ok.txt
```

* 정적 파일 기반
* reverse proxy / 로드밸런서 환경에서 생존 체크 용도

---

## 🧪 분석 관련 (현재는 스텁)

> ⚠️ 아래 기능은 **구조만 존재**하며, 실제 분석 정확도를 보장하지 않습니다.

### 분석 업로드 (초안)

```http
POST /analyze/upload
```

* 업로드와 동시에 분석 실행
* 현재는 스텁 JSON 반환
* 추후 **Job 기반 API로 대체 예정**

---

### OpenCV / ML 워커 (스텁 구조)

#### `analysis/opencv_worker.py`

* stdin 입력:

```json
{
  "path": "/uploads/sample.mp4",
  "fps": 100,
  "roi": null
}
```

* stdout 출력:

```json
{
  "events": {},
  "metrics": {},
  "ball": {}
}
```

> 향후 Pi 환경에서 OpenCV / ONNX / TFLite 기반 로직으로 교체 예정

---

#### `analysis/engine.js`

* Node.js → Python 워커 호출
* 워커 실패 시:

  * 스텁 결과 반환 (fallback)
* 향후:

  * Job 큐 기반 워커 관리로 리팩토링 예정

---

## 🔄 예정된 리팩토링 방향 (중요)

### 1️⃣ 업로드 API → 분석 Job API 분리

**현재**

* `/api/upload`
* `/analyze/upload`

**향후**

```http
POST /api/analyze        # 업로드 + job 생성
GET  /api/analyze/{id}  # 상태 조회
GET  /api/analyze/{id}/result
```

---

### 2️⃣ 결과 스키마 표준화

* 이벤트:

  * address / top / impact / finish
* 템포:

  * backswing : downswing ratio
  * downswing_ms
* 클럽 트래킹:

  * **TO-DO (YOLO 적용 후)**
* 볼 지표:

  * launch direction / angle (근사)

---

### 3️⃣ 분석 파이프라인 단계화

1. 영상 디코딩
2. 임팩트 시점 검출
3. 이벤트 분할
4. 템포 계산
5. (추후) 클럽 트래킹
6. (선택) 디버그 아티팩트 생성

---

### 4️⃣ 라즈베리파이 환경 최적화

* 프레임 샘플링 옵션
* 분석 타임아웃
* 저전력/저메모리 대응
* 결과 캐싱

---

## 🚀 PM2 운영

### 설치

```bash
npm i -g pm2
```

### 실행

```bash
pm2 start ecosystem.config.cjs --env production
```

### 부팅 자동 시작

```bash
pm2 save
pm2 startup
```

### 설정 메모

* `ecosystem.config.cjs`

  * 기본 업로드 경로: `./uploads`
  * production 환경:

    * `/home/ray/uploads` 사용
* 라즈베리파이 재부팅 후 자동 복구됨

---

## 📌 설계 원칙

* ❌ 트랙맨 수준의 물리 수치 계산
* ❌ 스핀량(rpm) 정밀 측정
* ✅ 단일 DTL 카메라 기반 현실적 분석
* ✅ 이벤트 / 템포 / 경향 중심
* ✅ 실시간성 & 안정성 우선

---

## 🔜 Roadmap

* Job 큐 기반 분석 구조 완성
* YOLO 기반 클럽 헤드/샤프트 감지
* 분석 결과 히스토리 관리
* 프론트엔드와 API 스키마 완전 동기화

---

원하시면 다음 단계로

* **`server.js` 리팩토링 가이드 (파일 단위)**
* **Job 큐 최소 구현 예제 (Redis 없이)**
* **라즈베리파이 기준 분석 성능 예산표**

중에서 바로 이어서 정리해 드리겠습니다.

---

# ② Hailo-back 전달용 프롬프트
*(중앙 허브 · 분석 · 상태 관리)*

## 역할 정의 (Single Source of Truth)
Hailo-back은 시스템의 중심입니다.

- Hailo-camera ↔ Hailo-front 사이의 단일 진실 소스(SSOT)
- 분석 Job 생성/실행/상태 관리
- 파일/샷/세션/히스토리 관리
- (권장) 프록시/인증/안정성 책임(모바일/핫스팟 환경 포함)

---

## 1) 파일/메타 API 표준 (Front 필수 의존)
### API
`GET /api/files/detail`

### 응답 스펙(확정 요청)
```json
{
  "ok": true,
  "files": [
    {
      "filename": "xxx.mp4",
      "url": "/uploads/xxx.mp4",
      "shotId": "string | null",
      "jobId": "string | null",
      "analyzed": false,
      "status": "not-analyzed | queued | running | succeeded | failed",
      "size": 123,
      "modifiedAt": "2025-12-18T01:13:42.951Z",
      "analysis": null
    }
  ]
}
```

### 요구사항
- `.mp4`만 노출
- `url`은 프론트가 그대로 `<video src>`로 사용 가능해야 함(동일 오리진)
- `analyzed` 정의:
  - `true`: 분석 결과가 유효하게 존재(“분석 완료”)
  - `false`: 분석 결과 없음(“분석” 버튼 노출)
- `status`는 아래 enum으로 반드시 통일:
  - `not-analyzed | queued | running | succeeded | failed`
- `analysis`는 `null` 가능(없으면 미분석 또는 실패로 처리)

### 완료 기준
- `/api/files/detail` 스펙이 위 형태로 고정되고, “미분석 파일도 목록에 포함”되며, `status` 값이 enum으로 통일됨.

---

## 2) 기존 파일 분석 트리거 API (중요 / 재업로드 제거)
프론트에서 mp4를 다시 다운로드→업로드 없이, Pi에 이미 존재하는 파일을 서버 측에서 바로 분석 트리거할 수 있어야 합니다.

### API
`POST /api/analyze/from-file`
```json
{ "filename": "xxx.mp4" }
```

### 응답
```json
{ "ok": true, "jobId": "...", "filename": "xxx.mp4" }
```

### 권장 옵션(있으면 좋음)
- `force: boolean` (기존 분석 결과가 있어도 재분석)
- `sessionId/sessionName`, `meta(fps, roi, cameraConfig...)` 전달 지원

### 완료 기준
- 프론트 “분석” 버튼 클릭 시 재업로드 없이 job 생성이 가능하고,
- job 완료 후 `/api/files/detail`의 `status/analyzed/analysis`가 즉시 일관되게 갱신됨.

---

## 3) 분석 Job 관리 (상태/이벤트)
### 상태 흐름(고정)
`not-analyzed → queued → running → succeeded | failed`

### 상태 조회(최소)
- `GET /api/analyze/{jobId}`
- 응답에 `status` + (가능하면) `analysis` 또는 `errorMessage`

### 실시간 업데이트(권장: SSE 또는 WS)
SSE 선호(단순/방화벽 친화적):

`GET /api/analyze/{jobId}/events` (SSE)

- 이벤트 예시: `status_changed`, `progress`, `log`, `completed`, `failed`
- 최소 요건: `queued/running/succeeded/failed` 전환을 push로 전달

---

## 4) 분석 결과 스펙 (In Scope 고정 / 범주형 우선)
프론트가 “코칭/경향/추세”로 보여줄 수 있도록, 아래 항목을 `analysis.metrics`에 필수 포함하도록 스펙 확정 요청합니다.

### 필수 포함
- 스윙 이벤트: `address/top/impact/finish` (각 이벤트에 `timeMs`, 권장: `frame`)
- 템포/리듬: `backswingMs`, `downswingMs`, `ratio`
- 스윙 플레인 경향(범주형):
  - `inside-out | neutral | outside-in`
  - `confidence: 0~1`
- 어택/패스(범주형 우선):
  - 예: `down-blow | neutral | up-blow`

### Out of Scope (명시적으로 제외)
- 스핀(rpm) 정량
- 비거리/볼비행 정밀 계산
- 런치모니터급 정밀 볼스피드/발사각

---

## 5) 프록시/게이트웨이 (강력 권장)
모바일/핫스팟 환경에서 CORS/토큰/브라우저 제약을 줄이기 위해, Hailo-back이 동일 오리진 게이트웨이를 제공하면 안정성이 크게 올라갑니다.

- `/api/camera/*` → Hailo-camera로 reverse proxy
- `/uploads/*` → static 또는 proxy로 동일 오리진 제공

---

## Hailo-back 측 답변 요청사항
- 1~4의 확정 스펙(필드/enum/JSON 구조) 문서화
- `POST /api/analyze/from-file`의 최종 요청/응답 및 에러 케이스(404, 409, 500 등)
- 상태 push 방식 선택(SSE/WS) 및 최소 이벤트 페이로드 정의
- job/이력 저장 범위(shotId/jobId/sessionId 매핑)와 보존 정책(최소 최근 N개 등) 제안
