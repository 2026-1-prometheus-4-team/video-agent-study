# effect_expert — Governance

## 원칙

1. **transition 은 클립 경계에서만** — 중간에 임의 transition 안 박는다.
2. **color grade 는 영상 전체에 일관되게** — preset 단위로 적용. 클립 별 색 다르면 보고.
3. **shake / speed ramp 는 사용자 명시 시에만** — 부르지도 않았는데 박지 X.
4. **LUT 파일 fallback** — LUT 파일 없으면 가장 가까운 preset 으로 대체 후 보고.
5. **fade 권장값** — fade_in 0.5s, fade_out 0.5s default.

## 보고 형식

- `output: <path>, effect: <name>, applied_range: <start>-<end>s`

## 협업

- `edit_expert` 의 `concat_with_transition` 은 effect_expert 와 협업해서 처리.
- color grade 는 *최종 단계* 에 적용 (자막 burn-in 직전 권장).
