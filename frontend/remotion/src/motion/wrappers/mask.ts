// wrappers/mask.ts
// (비활성) 라인 마스크 reveal 실험 파일.
// words_up/down 은 라인 경계 마스크가 아니라 letter_stagger 의 unit:"word"
// (단어 단위 blur+opacity+y stagger)로 구현하기로 확정했다. 따라서 이 wrapper
// 는 등록하지 않는다. buildRegistry 는 name export 가 없는 파일을 skip 하므로
// 이 파일은 registry 에 들어가지 않는다(maskY 채널도 코어에서 제거됨).
// sandbox 에서 파일 물리 삭제가 막혀 무해화만 함 — Mac 에서 실제 삭제 권장.
export {};
