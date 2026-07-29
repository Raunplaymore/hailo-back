# 작업 데이터 보존과 복구

Pi는 실행 캐시이고 NAS가 완료된 분석 작업의 영구 보관소다. `done` 또는 `failed` job은 NAS에 원본 영상, `meta.json`, 분석 cache/result, body 결과, 썸네일, manifest를 job ID별로 보관한다.

- Pi의 `/tmp/*.meta.json`은 재현 가능한 원본이 아니다. 백엔드는 수신한 유효 meta를 `/home/ray/data/meta/`에도 저장한다.
- 디버그 프레임 조회 시 로컬 meta가 없으면 NAS의 `meta/meta.json`을 내려받아 영속 meta 경로로 복구한다.
- Pi에서 원본이나 캐시를 자동 삭제하지 않는다. 삭제 정책은 NAS manifest가 `stored`임을 확인하고 보존 기간을 합의한 뒤 별도 구현한다.
- 사용자가 파일을 명시적으로 삭제하면 Pi와 NAS의 동일 job을 함께 삭제한다.

2026-07-25 job `6b9a0b45-03fd-4d18-a194-338e660a05a7`은 이 규약의 복구 검증 사례다. `/tmp` 메타는 사라졌지만 NAS 아카이브의 영상·meta·분석·라벨은 남아 있었다.
