"""자동 자막이 편집본 원본 전사를 재사용하고 최종 stem에 기록하는지 검증."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

from agent.tools import subtitle, subtitle_cues


def test_render_error_understands_json_payload():
    assert subtitle._render_error('{"status":"error","error":"font missing"}') == "font missing"
    assert subtitle._render_error("ERROR: ffmpeg failed") == "ffmpeg failed"
    assert subtitle._render_error("/tmp/final.mp4") is None


def test_style_dict_is_applied_without_json_roundtrip():
    style = subtitle._merge_style({
        "platform": "shorts",
        "font": "Noto Sans CJK KR",
        "font_size": 36,
    })

    assert style["platform"] == "shorts"
    assert style["font"] == "Noto Sans CJK KR"
    assert style["font_size"] == 36


def test_display_segments_keep_spoken_text_separate_and_style_sounds():
    spoken = [
        {"start": 0.0, "end": 1.0, "text": "이게 왜 안 되지?"},
        {"start": 1.2, "end": 2.0, "text": "다시 해볼게요"},
    ]
    correction = {
        "display_edits": [{
            "segment_index": 0,
            "display_text": "(당황) 이게 왜 안 되지?",
        }],
        "sound_captions": [{
            "start": 1.0,
            "end": 1.2,
            "text": "[쾅]",
        }],
    }

    # 기본: 효과음 캡션([쾅])은 제외 — 발화 자막과 (당황) 감정표현만 남는다.
    display = subtitle._display_segments(spoken, correction)
    assert spoken[0]["text"] == "이게 왜 안 되지?"
    assert [item["text"] for item in display] == [
        "(당황) 이게 왜 안 되지?",
        "다시 해볼게요",
    ]
    assert all(item.get("kind") != "sound" for item in display)

    # include_sound_captions=True 면 효과음 캡션을 상단에 포함.
    with_sound = subtitle._display_segments(
        spoken, correction, include_sound_captions=True
    )
    assert [item["text"] for item in with_sound] == [
        "(당황) 이게 왜 안 되지?",
        "[쾅]",
        "다시 해볼게요",
    ]
    assert with_sound[1]["kind"] == "sound"
    assert with_sound[1]["style"]["position"] == "top"


def test_absolute_output_reuses_origin_and_writes_final_sidecars(tmp_path):
    source = tmp_path / "outputs" / "edited.mp4"
    source.parent.mkdir()
    source.write_bytes(b"video")
    subs = tmp_path / "videos" / "subtitles"
    subs.mkdir(parents=True)
    fonts = tmp_path / "assets" / "fonts"
    fonts.mkdir(parents=True)
    (fonts / "NotoSansKR-Regular.ttf").write_bytes(b"font")
    transcript = [{"start": 0.2, "end": 1.4, "text": "원본에서 온 자막"}]

    def fake_render(payload):
        output = Path(payload["output_path"])
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"subtitled")
        return str(output)

    with patch("agent.tools.subtitle_cues.render_subtitles") as fake_render_tool, \
         patch.object(subtitle, "SUBTITLES_DIR", str(subs)), \
         patch.object(subtitle, "VIDEOS_DIR", str(tmp_path / "videos")), \
         patch.object(subtitle, "_transcript_from_origin", return_value=transcript), \
         patch.object(subtitle_cues, "SUBTITLES_DIR", str(subs)), \
         patch.object(subtitle_cues, "FONTS_DIR", str(fonts)):
        fake_render_tool.invoke.side_effect = fake_render
        result = json.loads(subtitle.add_auto_subtitle.invoke({
            "video_path": str(source),
            "style": json.dumps({"platform": "shorts"}),
        }))

    assert result["status"] == "success"
    assert result["output"] == str(source.with_name("edited_subtitled.mp4"))
    final_json = subs / "edited_subtitled.json"
    final_cues = subs / "edited_subtitled.cues.json"
    assert final_json.exists()
    assert final_cues.exists()
    saved = json.loads(final_json.read_text(encoding="utf-8"))
    assert saved["segments"] == transcript
    assert saved["raw_segments"] == transcript
    assert saved["display_segments"] == transcript


def test_origin_expression_is_rendered_but_canonical_sidecar_stays_clean(tmp_path):
    source = tmp_path / "outputs" / "edited.mp4"
    source.parent.mkdir()
    source.write_bytes(b"video")
    subs = tmp_path / "videos" / "subtitles"
    subs.mkdir(parents=True)
    transcript = [{
        "start": 0.2,
        "end": 1.4,
        "text": "이게 왜 안 되지?",
        "display_text": "(당황) 이게 왜 안 되지?",
        "kind": "speech",
    }]

    def fake_render(payload):
        output = Path(payload["output_path"])
        output.write_bytes(b"subtitled")
        return str(output)

    with patch("agent.tools.subtitle_cues.render_subtitles") as render_tool, \
         patch.object(subtitle, "SUBTITLES_DIR", str(subs)), \
         patch.object(subtitle, "_transcript_from_origin", return_value=transcript), \
         patch.object(subtitle_cues, "SUBTITLES_DIR", str(subs)):
        render_tool.invoke.side_effect = fake_render
        result = json.loads(subtitle.add_auto_subtitle.invoke({
            "video_path": str(source),
        }))

    saved = json.loads((subs / "edited_subtitled.json").read_text(encoding="utf-8"))
    cues = json.loads((subs / "edited.cues.json").read_text(encoding="utf-8"))
    assert saved["segments"] == [{
        "start": 0.2,
        "end": 1.4,
        "text": "이게 왜 안 되지?",
    }]
    assert saved["display_segments"][0]["text"] == "(당황) 이게 왜 안 되지?"
    assert cues["cues"][0]["text"] == "(당황) 이게 왜 안 되지?"
    assert result["expressive_captions"] == 1


def test_saved_display_sidecar_can_be_reused_by_later_edits(tmp_path):
    """한 번 렌더한 편집본을 다시 잘라도 화면용 자막이 사라지지 않아야 한다."""
    subs = tmp_path / "subtitles"
    subs.mkdir()
    source = tmp_path / "edited.mp4"
    source.write_bytes(b"video")
    (subs / "edited.json").write_text(
        json.dumps({
            "schema_version": 2,
            "segments": [{
                "start": 0.0,
                "end": 1.0,
                "text": "이게 왜 안 되지?",
            }],
            "raw_segments": [{
                "start": 0.0,
                "end": 1.0,
                "text": "이게 왜 안 되지?",
            }],
            "display_segments": [
                {
                    "start": 0.0,
                    "end": 1.0,
                    "text": "(당황) 이게 왜 안 되지?",
                },
                {
                    "start": 1.1,
                    "end": 1.5,
                    "text": "[쾅]",
                    "kind": "sound",
                },
            ],
            "correction": None,
        }, ensure_ascii=False),
        encoding="utf-8",
    )

    with patch.object(subtitle, "SUBTITLES_DIR", str(subs)):
        speech = subtitle._source_speech(str(source))

    assert speech[0]["text"] == "이게 왜 안 되지?"
    assert speech[0]["display_text"] == "(당황) 이게 왜 안 되지?"
    assert speech[1]["text"] == ""
    assert speech[1]["display_text"] == "[쾅]"
    assert speech[1]["kind"] == "sound"


def test_custom_output_path_is_honored(tmp_path):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"video")
    subs = tmp_path / "subtitles"
    subs.mkdir()
    transcript = [{"start": 0, "end": 1, "text": "자막"}]
    custom = tmp_path / "custom.mp4"

    def fake_render(payload):
        output = Path(payload["output_path"])
        output.write_bytes(b"rendered")
        return str(output)

    with patch("agent.tools.subtitle_cues.render_subtitles") as render_tool, \
         patch.object(subtitle, "SUBTITLES_DIR", str(subs)), \
         patch.object(subtitle, "_transcript_from_origin", return_value=transcript), \
         patch.object(subtitle_cues, "SUBTITLES_DIR", str(subs)):
        render_tool.invoke.side_effect = fake_render
        result = json.loads(subtitle.add_auto_subtitle.invoke({
            "video_path": str(source),
            "output_path": str(custom),
        }))

    assert result["status"] == "success"
    assert result["output"] == str(custom)


def test_burn_false_keeps_video_clean_and_writes_cues(tmp_path):
    """burn=False: 영상은 굽지 않고 깨끗한 복사본 + cue 문서만 남긴다."""
    source = tmp_path / "outputs" / "edited.mp4"
    source.parent.mkdir()
    source.write_bytes(b"clean-video")
    # 원본 origin/pad 사이드카가 있으면 출력으로 승계돼야 downstream 추적이 된다.
    (tmp_path / "outputs" / "edited.mp4.origin.json").write_text("[]", encoding="utf-8")
    subs = tmp_path / "videos" / "subtitles"
    subs.mkdir(parents=True)
    transcript = [{"start": 0.2, "end": 1.4, "text": "굽지 않은 자막"}]
    custom = tmp_path / "outputs" / "clean_out.mp4"

    with patch("agent.tools.subtitle_cues.render_subtitles") as render_tool, \
         patch.object(subtitle, "SUBTITLES_DIR", str(subs)), \
         patch.object(subtitle, "VIDEOS_DIR", str(tmp_path / "videos")), \
         patch.object(subtitle, "_transcript_from_origin", return_value=transcript), \
         patch.object(subtitle_cues, "SUBTITLES_DIR", str(subs)):
        result = json.loads(subtitle.add_auto_subtitle.invoke({
            "video_path": str(source),
            "output_path": str(custom),
            "burn": False,
        }))

    # 렌더(burn)는 호출되지 않아야 한다.
    render_tool.invoke.assert_not_called()
    assert result["status"] == "success"
    assert result["burned"] is False
    assert result["output"] == str(custom)
    # 출력은 원본과 동일한 깨끗한 영상 (자막이 구워지지 않음).
    assert custom.read_bytes() == b"clean-video"
    # origin 사이드카 승계.
    assert (custom.parent / "clean_out.mp4.origin.json").exists()
    # cue 문서 + 사이드카가 출력 stem 으로 기록돼 server 복구가 찾는다.
    assert (subs / "clean_out.json").exists()
    assert (subs / "clean_out.cues.json").exists()
    saved = json.loads((subs / "clean_out.json").read_text(encoding="utf-8"))
    assert saved["source_video"] == str(custom)
