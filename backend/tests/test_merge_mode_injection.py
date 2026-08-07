"""plan 정규화가 merge_video 에 crop 을 강제로 박으면 안 된다.

실제 증상: 가로 소스가 세로 쇼츠에서 계속 잘려 나왔다. merge_video 의 기본값을
클립별 판단(auto)으로 바꾸고 프롬프트도 "mode 를 지정하지 마라" 로 고쳤는데도
그대로였다. plan 생성 *뒤* 에 도는 _propagate_target_aspect_ratio 가 모든
merge_video step 에 mode="crop" 을 덮어쓰고 있었기 때문이다.
"""

from __future__ import annotations

import importlib

import pytest

sn = importlib.import_module("agent.nodes.script_node")


def _merge_params(plan: dict) -> dict:
    result = sn._propagate_target_aspect_ratio(plan)
    return next(
        s["params"] for s in result["steps"] if s["action"] == "merge_video"
    )


def _plan(merge_params: dict, extra_steps: list | None = None) -> dict:
    return {
        "target_aspect_ratio": "9:16",
        "steps": [
            {"action": "merge_video", "params": {**merge_params}},
            *(extra_steps or []),
        ],
    }


def test_mode_is_left_to_the_tool_by_default():
    """지정이 없으면 mode 를 넣지 않는다 — merge_video 의 auto 가 클립마다 정한다."""
    params = _merge_params(_plan({"clip_paths": ["a.mp4"], "output_path": "m.mp4"}))

    assert params["aspect_ratio"] == "9:16"
    assert "mode" not in params


def test_aspect_ratio_is_still_propagated():
    """화면비는 계속 넘긴다 — 병합 뒤 변환은 되돌릴 수 없다."""
    params = _merge_params(_plan({"clip_paths": ["a.mp4"], "output_path": "m.mp4"}))
    assert params["aspect_ratio"] == "9:16"


@pytest.mark.parametrize("mode", ["crop", "pad"])
def test_explicit_mode_on_merge_is_kept(mode):
    """사용자 요청으로 plan 에 적힌 mode 는 그대로 존중한다."""
    params = _merge_params(
        _plan({"clip_paths": ["a.mp4"], "output_path": "m.mp4", "mode": mode})
    )
    assert params["mode"] == mode


@pytest.mark.parametrize("mode", ["crop", "pad"])
def test_downstream_resize_mode_is_inherited(mode):
    """뒤따르는 resize 가 mode 를 정했으면 병합도 같은 방식이어야 한다."""
    params = _merge_params(
        _plan(
            {"clip_paths": ["a.mp4"], "output_path": "m.mp4"},
            [
                {
                    "action": "resize_video",
                    "params": {
                        "video_path": "m.mp4",
                        "aspect_ratio": "9:16",
                        "mode": mode,
                    },
                }
            ],
        )
    )
    assert params["mode"] == mode


def test_unknown_mode_is_dropped():
    """모르는 값은 툴에서 ERROR 가 되므로 여기서 걸러 auto 로 보낸다."""
    params = _merge_params(
        _plan({"clip_paths": ["a.mp4"], "output_path": "m.mp4", "mode": "stretch"})
    )
    assert "mode" not in params
