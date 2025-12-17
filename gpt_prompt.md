알겠습니다.
현재 구조를 유지하면서 **“업로드 서버 → 분석 Job 서버로 리팩토링 예정”**이라는 방향이 명확히 드러나도록,
그리고 **지금 되는 것 / 앞으로 바뀔 것**이 구분되도록 `README.md`를 정리해서 업데이트해 드리겠습니다.

아래 내용은 **백엔드 저장소의 최신 README로 그대로 교체해도 되는 버전**입니다.

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
UPLOAD_DIR=/home/pi/uploads node server.js
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

    * `/home/pi/uploads` 사용
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
