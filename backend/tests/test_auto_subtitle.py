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
    assert json.loads(final_json.read_text(encoding="utf-8"))["segments"] == transcript


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
