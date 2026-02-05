# pi_service Context

## 프로젝트 개요
골프 스윙 분석 백엔드. 파일 업로드, Job 관리, OpenCV 기반 보조 분석, hailo-infer 연동.

## 자주 수정하는 파일

### 핵심 로직
- `server.js` - Express 서버, 라우팅, Job 관리
- `analysis/engine.js` - 분석 엔진, Python 워커 호출
- `analysis/opencv_worker.py` - OpenCV 기반 공 검출/임팩트 추정

### 데이터 관리
- `store/job_store.js` - 분석 Job 상태 관리
- `store/shotStore.js` - Shot 데이터 저장

### 분석 유틸
- `analysis/event_detector.js` - 이벤트 감지 휴리스틱
- `analysis/meta_parser.js` - 메타 파싱
- `analysis/metrics_calculator.js` - 메트릭 계산
- `analysis/track_utils.js` - 트래킹 유틸리티

### 프리체크
- `analysis/precheck_worker.py` - 스윙 여부 프리체크

## 분석 파이프라인

### 플로우
```
1. POST /api/analyze/from-file { jobId, filename, metaPath }
2. hailo-infer에 위임 → POST /v1/jobs (coach_from_meta)
3. 폴링으로 상태 확인
4. 결과 캐싱: DATA_DIR/analysis/<jobId>.json
```

### Job 상태
- `pending` - 대기 중
- `queued` - hailo-infer 큐 대기
- `running` - 분석 중
- `succeeded` - 완료
- `failed` - 실패

### 에러 코드
- `NOT_SWING` - 스윙이 아닌 영상 (프리체크 실패)
- `DECODE_FAILED` - 비디오 디코딩 실패
- `META_LOAD_FAILED` - 메타 파일 로드 실패
- `UNEXPECTED` - 예상치 못한 에러

## 주의사항

### 파일 처리
- iPhone `.mov` 지원: ffmpeg 자동 변환/리먹스
- 변환 실패 시 `DECODE_FAILED` 에러
- `.part` 파일은 무시 (미완성)
- 파일명 URL 인코딩 필수

### 분석 트리거
- `force=true`로 프리체크 무시 가능
- 캐시된 결과 있으면 재분석 스킵 (force 제외)
- 메타 파일 우선, 없으면 영상에서 추출 (비활성화 가능)

### hailo-infer 연동
- `INFER_BASE_URL` 설정 필수 (기본 `http://127.0.0.1:8002`)
- 권장: `http://127.0.0.1:3002` (hailo-infer 기본 포트)
- 타임아웃: 분석 완료까지 폴링 (상태 조회)

## 환경변수

### 필수
- `UPLOAD_DIR=/home/ray/uploads` - 업로드 파일 경로
- `DATA_DIR=/home/ray/data` - 데이터 저장 경로

### 선택
- `INFER_BASE_URL=http://127.0.0.1:3002` - hailo-infer 주소
- `ALLOWED_ORIGIN=*` - CORS 설정

## API 주요 엔드포인트

### 파일 관리
- `GET /api/files` - Shot 기준 파일 목록
- `GET /api/files/detail` - 상세 목록 (상태 포함)
- `DELETE /api/files/:filename` - 파일 삭제

### 분석
- `POST /api/analyze/from-file` - 메타 기반 분석
- `POST /api/analyze/upload` - 업로드 + 분석
- `GET /api/analyze/:jobId` - 상태 조회
- `GET /api/analyze/:jobId/result` - 결과 조회

### Shot/Session
- `GET /api/shots` - Shot 목록
- `GET /api/shots/:id/analysis` - Shot 분석 결과
- `GET /api/sessions` - 세션 목록

## 파일 목록 응답 포맷

```json
{
  "ok": true,
  "files": [
    {
      "filename": "session_123.mp4",
      "url": "/uploads/session_123.mp4",
      "shotId": "...",
      "jobId": "session_123",
      "analyzed": true,
      "status": "succeeded",
      "size": 1234567,
      "modifiedAt": "2024-01-01T00:00:00.000Z",
      "analysis": { ... },
      "errorCode": null,
      "errorMessage": null
    }
  ]
}
```

### 상태 값
- `not-analyzed` - 분석 전
- `queued` - 대기
- `running` - 진행 중
- `succeeded` - 성공
- `failed` - 실패

## 분석 결과 스키마

```json
{
  "ok": true,
  "jobId": "...",
  "status": "succeeded",
  "events": {
    "addressMs": 0,
    "topMs": 820,
    "impactMs": 1220,
    "finishMs": 1600
  },
  "metrics": {
    "swingPlane": { "label": "inside-out", "confidence": 0.62 },
    "tempo": { "backswingMs": 820, "downswingMs": 400, "ratio": 2.05 },
    "impactStability": { "label": "stable", "score": 0.74 }
  },
  "summary": "...",
  "meta": {
    "fps": 60,
    "width": 1456,
    "height": 1088,
    "durationMs": 2000,
    "analysisVersion": "hailo-coach-v1"
  }
}
```

## 디버깅 팁

### hailo-infer 연결 안 될 때
1. `INFER_BASE_URL` 확인
2. hailo-infer 서비스 실행 상태 확인
3. 포트 충돌 확인 (3002)

### 분석 실패 시
1. Job errorCode/errorMessage 확인
2. hailo-infer 로그 확인
3. 메타 파일 존재/포맷 확인

### OpenCV 워커 에러
1. Python 의존성 확인: `opencv-python`, `numpy`
2. `analysis/opencv_worker.py` 직접 실행 테스트
3. stdout/stderr 로그 확인

### 프리체크 false positive
1. `force=true`로 무시
2. 임계값 조정 (precheck_worker.py)
3. 프리체크 비활성화 (코드 수정)

## 알려진 제약사항

### OpenCV 분석
- 프로토타입 수준: 검출 실패 시 `null` 반환
- 신뢰도 낮을 수 있음: fps/FOV/ROI 정보 함께 제공 권장
- 스핀/캐리 계산 불가 (단일 카메라 한계)

### iPhone 영상
- `.mov` 자동 변환 (ffmpeg 필요)
- 변환 실패 시 분석 불가
- 일부 코덱 미지원 가능

### Job 큐
- 현재 단순 메모리 큐
- 서버 재시작 시 진행 중 Job 유실 가능
- 추후 Redis/DB 기반으로 고도화 필요

## 코딩 컨벤션

### 에러 응답
```javascript
res.status(400).json({
  ok: false,
  status: 'failed',
  errorCode: 'NOT_SWING',
  errorMessage: 'No swing motion detected'
});
```

### Job 상태 업데이트
- 상태 변경 시 즉시 메모리 + 파일 동기화
- 에러 발생 시 errorCode/errorMessage 함께 저장

### Python 워커 호출
- `spawn('python3', [script, ...args])`
- stdout을 JSON으로 파싱
- 타임아웃 설정 필수
