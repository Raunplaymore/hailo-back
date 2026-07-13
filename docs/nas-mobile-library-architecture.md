# NAS 중심 모바일 스윙 라이브러리 설계

## 목적

완료된 스윙의 기준 저장소를 Raspberry Pi에서 NAS로 옮긴다. 모바일 사용자는 Pi의 전원, LAN 연결,
IP 주소와 무관하게 NAS에서 영상과 분석 결과를 조회하고 삭제할 수 있어야 한다.

## 역할 경계

| 구성요소 | 책임 | 기준 데이터 |
| --- | --- | --- |
| 모바일 웹앱 | 로그인, 목록/상세/재생/삭제 UI | NAS library API |
| NAS library | 완료 job 보관, 인증, 목록, 스트리밍, 삭제 이력 | `jobId`별 manifest와 artifact |
| Raspberry Pi | 촬영, pose/club 분석, NAS 업로드, 삭제 이력 동기화 | 처리 중인 임시 파일 |

Pi는 장기 기록의 조회 서버가 아니다. Pi가 꺼져도 NAS에 보관 완료된 기록은 모바일에서 계속 이용할 수 있다.

## 네트워크와 인증

### 외부 진입점

초기 운영은 NAS의 Tailscale HTTPS 주소를 모바일에서 사용한다. NAS Docker 포트를 LAN 또는 인터넷에
직접 공개하지 않는다. 공개 도메인이 필요해질 경우에만 별도 reverse proxy 또는 tunnel을 추가하고,
동일한 HTTPS와 인증 정책을 유지한다.

### 권한 분리

| 주체 | 인증 수단 | 허용 작업 |
| --- | --- | --- |
| Pi archive client | `NAS_ARCHIVE_TOKEN` Bearer token | artifact/manifest 업로드, 삭제 이력 조회 |
| 모바일 브라우저 | NAS 로그인 후 발급한 Secure/HttpOnly 세션 쿠키 | 본인 library 조회, 영상 재생, 삭제 |
| NAS 내부 작업 | Docker 내부 환경변수 | 파일 시스템, index, tombstone 관리 |

`NAS_ARCHIVE_TOKEN`은 브라우저, Vite 환경변수, API 응답, manifest에 절대 포함하지 않는다. 현재
`storage-api`의 raw archive API는 Pi 전용 내부 API로 유지하며, 모바일은 별도의 library API만 호출한다.

## 데이터 모델

`jobId`는 Pi 분석부터 NAS 보관 및 삭제까지 변하지 않는 immutable key다.

```text
/archive/jobs/<jobId>/
  manifest.json
  video/video.mp4                 # 원본이 남아 있을 때만
  analysis-cache/analysis-cache.json
  analysis-result/analysis-result.json
  body/body.json
  meta/meta.json

/archive/tombstones/<jobId>.json  # NAS에서 삭제된 job
```

manifest에는 `archivedAt`, 사용 가능한 artifact 목록, `videoStored`, 촬영 시각, 분석 상태와 요약을
기록한다. 영상이 Pi에서 먼저 정리된 경우에도 분석 결과 보관은 성공이며 `videoStored: false`다.

초기 규모에서는 manifest를 읽어 목록을 만들 수 있다. job 수가 수천 건 또는 사용자/검색 조건이 늘어나면
NAS library 프로세스가 원자적으로 갱신하는 `library-index.json`을 도입한다. DB는 이 단계가 실제 병목이
될 때만 추가한다.

## NAS library API 계약

모든 `/api/library/*` endpoint는 세션 로그인 후에만 제공한다.

| 메서드 | 경로 | 용도 |
| --- | --- | --- |
| `POST` | `/api/auth/login` | 로그인 및 HttpOnly 세션 발급 |
| `POST` | `/api/auth/logout` | 세션 폐기 |
| `GET` | `/api/auth/me` | 로그인 상태 확인 |
| `GET` | `/api/library/jobs?cursor=&limit=` | 완료 job 목록 |
| `GET` | `/api/library/jobs/:jobId` | manifest와 분석 결과 상세 |
| `GET` | `/api/library/jobs/:jobId/video` | HTTP Range 지원 영상 스트리밍 |
| `DELETE` | `/api/library/jobs/:jobId` | NAS 삭제 및 tombstone 기록 |
| `GET` | `/api/internal/deletions?cursor=` | Pi 전용 tombstone 동기화 feed |

`DELETE`는 idempotent여야 한다. 이미 삭제된 job에도 성공 응답을 주며 tombstone의 `deletedAt`과
삭제 cursor를 반환한다. 영상이 없는 job의 video endpoint는 `404 video_unavailable`을 반환하고,
상세/분석 조회는 정상 동작한다.

## 삭제 일관성

모바일에서 NAS 삭제가 성공하면 다음 순서를 보장한다.

1. NAS가 tombstone을 원자적으로 기록한다.
2. NAS의 `jobs/<jobId>` artifact를 삭제한다.
3. Pi가 다음 동기화에서 tombstone을 받고 로컬 영상, body, meta, analysis cache, shot record를 삭제한다.
4. Pi는 업로드/retry 전에 tombstone을 확인한다. 삭제된 job은 재업로드하지 않는다.

Pi가 꺼져 있어도 1~2단계는 완료된다. Pi는 켜진 뒤 3~4단계를 수행하므로 삭제한 데이터가 재등장하지
않는다. Pi의 기존 웹 삭제는 NAS 삭제 API를 호출하는 호환 경로로 유지하되, 최종 UI는 NAS API를 직접
호출한다.

## 웹앱 전환

NAS에 Vite production build를 제공하는 `web` Docker 서비스를 추가한다. 모바일의 기본 접속 주소는
NAS HTTPS 주소가 된다.

- 완료된 목록·상세·영상 URL: NAS library API
- `pending`/`running`인 최근 분석: Pi 상태 API를 보조 카드로 병합
- NAS 업로드가 끝난 job: 즉시 NAS library record로 전환
- Pi가 오프라인이면 진행 중 카드만 숨기고 완료된 NAS 기록은 계속 표시

## 단계별 실행과 완료 기준

### Phase 1 — NAS library 기반

- `storage-api`와 분리된 `library-api` Docker 서비스 추가
- 세션 로그인, job 목록/상세, Range video, idempotent delete 구현
- tombstone 파일과 Pi 전용 삭제 feed 구현

완료 기준: Pi를 끈 상태에서 Tailscale 연결 모바일이 NAS에서 목록·상세·영상·삭제를 수행한다.

### Phase 2 — Pi 동기화

- Pi에 삭제 feed cursor를 영속화
- 시작 시 및 주기적으로 tombstone 반영
- 업로드와 retry 전 tombstone 차단

완료 기준: NAS에서 삭제 후 Pi를 재시작해도 해당 job의 로컬 파일과 NAS artifact가 재생성되지 않는다.

### Phase 3 — NAS 웹 배포

- NAS Docker에 웹 build/serve service 추가
- 웹 API 클라이언트를 NAS library 중심으로 전환
- Pi 진행 상태를 보조로 병합

완료 기준: Pi 서비스가 꺼진 상황에서도 NAS URL의 모바일 웹앱이 완료 기록을 정상 렌더링한다.

### Phase 4 — 운영 강화

- library index, pagination, 검색/필터
- 세션 만료, 로그인 rate limit, audit log
- NAS 백업/복구, 저장 용량 경보, 영상 보존 정책

완료 기준: 삭제·로그인·스트리밍·백업 실패가 관측 가능하며 데이터 보존 정책을 문서화한다.

## 검증 시나리오

1. Pi에서 분석 완료 → NAS 목록과 영상/분석 상세에 나타난다.
2. Pi 전원 차단 → 모바일 NAS 웹에서 같은 job을 재생·조회한다.
3. 모바일 NAS 웹에서 삭제 → NAS artifact는 즉시 사라지고 tombstone이 생성된다.
4. Pi를 다시 켠다 → Pi가 tombstone을 적용하고 job을 재업로드하지 않는다.
5. 영상 없는 job → 분석 상세는 보이고 영상은 "원본 영상 없음"으로 표시된다.
