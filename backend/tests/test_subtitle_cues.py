"""
자막 큐 레이어 + TTS 개선 단위 테스트

FFmpeg/ElevenLabs 없이 오프라인으로 동작:
- subprocess.run mock (ffprobe/ffmpeg)
- requests.post mock (ElevenLabs)
- 디렉터리 상수는 tmp_path 로 patch
"""

from __future__ import annotations

import json
import threading
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from agent.tools import subtitle_cues
from agent.tools.audio_mix import mix_audio
from agent.tools.subtitle import _color_to_ass
from agent.tools.subtitle_cues import (
    add_subtitle_cue,
    list_subtitle_cues,
    render_subtitles,
    set_subtitle_style,
    update_subtitle_cues,
)
from agent.tools.tts import text_to_speech


SIDECAR_SEGMENTS = [
    {"start": 0.0, "end": 2.0, "text": "첫번째 자막"},
    {"start": 2.0, "end": 4.5, "text": "두번쨰 자막"},
    {"start": 4.5, "end": 6.0, "text": "세번째 자막"},
]


@pytest.fixture
def cue_env(tmp_path):
    """subtitle_cues 디렉터리 상수를 tmp_path 로 격리."""
    subs = tmp_path / "subtitles"
    fonts = tmp_path / "fonts"
    outputs = tmp_path / "outputs"
    subs.mkdir()
    fonts.mkdir()
    outputs.mkdir()
    (fonts / "NotoSansKR-Regular.ttf").write_bytes(b"fake_font")

    video = tmp_path / "sample.mp4"
    video.write_bytes(b"fake_video")

    with ExitStack() as stack:
        stack.enter_context(patch("agent.tools.subtitle_cues.SUBTITLES_DIR", str(subs)))
        stack.enter_context(patch("agent.tools.subtitle_cues.FONTS_DIR", str(fonts)))
        stack.enter_context(patch("agent.tools.subtitle_cues.OUTPUTS_DIR", str(outputs)))
        stack.enter_context(patch("agent.tools.subtitle_cues.VIDEOS_DIR", str(tmp_path)))
        yield {
            "tmp": tmp_path,
            "subs": subs,
            "fonts": fonts,
            "outputs": outputs,
            "video": video,
        }


def _write_sidecar(subs_dir: Path, stem: str = "sample") -> Path:
    path = subs_dir / f"{stem}.json"
    path.write_text(
        json.dumps(
            {"segments": SIDECAR_SEGMENTS, "language": "Korean", "engine": "openai"},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return path


def _make_doc(env, cues=None, style_defaults=None, source=None) -> Path:
    """큐 문서를 직접 생성해 저장."""
    doc, path = subtitle_cues.create_cues_doc(
        stem="sample",
        source_video=str(source or env["video"]),
        segments=cues or SIDECAR_SEGMENTS,
        style_defaults=style_defaults,
    )
    return Path(path)


# =============================================================
# 사이드카 → 큐 문서 승격
# =============================================================

class TestPromotion:
    def test_promote_sidecar_assigns_ids_and_source(self, cue_env):
        """사이드카만 있을 때 list 호출 → 큐 문서 자동 생성 + id 부여."""
        _write_sidecar(cue_env["subs"])

        result = json.loads(list_subtitle_cues.invoke({"video_path": str(cue_env["video"])}))

        assert result["status"] == "success"
        assert [c["id"] for c in result["cues"]] == ["c001", "c002", "c003"]
        assert result["source_video"] == str(cue_env["video"])
        assert result["version"] == 1
        assert (cue_env["subs"] / "sample.cues.json").exists()

    def test_no_cues_error(self, cue_env):
        """큐 문서도 사이드카도 없으면 no_cues 에러."""
        result = json.loads(list_subtitle_cues.invoke({"video_path": "ghost.mp4"}))
        assert result["status"] == "error"
        assert result["error"] == "no_cues"


# =============================================================
# update_subtitle_cues
# =============================================================

class TestUpdateCues:
    def test_update_text_by_id(self, cue_env):
        _make_doc(cue_env)
        result = json.loads(update_subtitle_cues.invoke({
            "video_path": str(cue_env["video"]),
            "updates": [{"id": "c002", "text": "두번째 자막"}],
        }))
        assert result["status"] == "success"
        assert result["updated"] == ["c002"]

        doc = json.loads((cue_env["subs"] / "sample.cues.json").read_text(encoding="utf-8"))
        assert doc["cues"][1]["text"] == "두번째 자막"

    def test_update_style_by_index(self, cue_env):
        _make_doc(cue_env)
        result = json.loads(update_subtitle_cues.invoke({
            "video_path": str(cue_env["video"]),
            "updates": [{"index": 0, "style": {"color": "#FFE600", "size": 30}}],
        }))
        assert result["updated"] == ["c001"]

        doc = json.loads((cue_env["subs"] / "sample.cues.json").read_text(encoding="utf-8"))
        assert doc["cues"][0]["style"] == {"color": "#FFE600", "size": 30}

    def test_delete_by_at_ms(self, cue_env):
        _make_doc(cue_env)
        result = json.loads(update_subtitle_cues.invoke({
            "video_path": str(cue_env["video"]),
            "updates": [{"at_ms": 3000, "delete": True}],  # 3.0초 → c002
        }))
        assert result["deleted"] == ["c002"]
        assert result["cue_count"] == 2

        doc = json.loads((cue_env["subs"] / "sample.cues.json").read_text(encoding="utf-8"))
        assert [c["id"] for c in doc["cues"]] == ["c001", "c003"]

    def test_not_found_reported(self, cue_env):
        _make_doc(cue_env)
        result = json.loads(update_subtitle_cues.invoke({
            "video_path": str(cue_env["video"]),
            "updates": [{"id": "c999", "text": "없는 큐"}],
        }))
        assert result["status"] == "partial"
        assert result["not_found"] == ["id=c999"]

    def test_invalid_timing_fails_item(self, cue_env):
        _make_doc(cue_env)
        result = json.loads(update_subtitle_cues.invoke({
            "video_path": str(cue_env["video"]),
            "updates": [{"id": "c001", "start": 5.0, "end": 1.0}],
        }))
        assert result["failed"][0]["id"] == "c001"
        assert result["updated"] == []

    def test_delete_then_index_resolves_against_original_list(self, cue_env):
        """[회귀] 배치 내 삭제 후 index 는 변형 전 리스트 기준이어야 함.

        먼저 index=0 을 지우면 리스트가 줄어 index=2 가 c003 이 아닌 다른 큐를
        가리켰다 (엉뚱한 자막이 조용히 수정됨).
        """
        _make_doc(cue_env)
        result = json.loads(update_subtitle_cues.invoke({
            "video_path": str(cue_env["video"]),
            "updates": [{"index": 0, "delete": True}, {"index": 2, "text": "fix"}],
        }))
        assert result["deleted"] == ["c001"]
        assert result["updated"] == ["c003"]  # 삭제 전 리스트의 index 2

        doc = json.loads((cue_env["subs"] / "sample.cues.json").read_text(encoding="utf-8"))
        by_id = {c["id"]: c for c in doc["cues"]}
        assert by_id["c003"]["text"] == "fix"
        assert by_id["c002"]["text"] == "두번쨰 자막"  # 오염되지 않음

    def test_at_ms_resolves_against_timings_before_batch(self, cue_env):
        """[회귀] 앞 spec 이 타이밍을 늘려도 at_ms 는 배치 전 타이밍 기준이어야 함.

        c001(0~2) 을 0~4 로 늘린 뒤 at_ms=3000 을 적용하면, 변형된 리스트 기준으로는
        c001 이 3.0초를 품게 돼 c002 대신 c001 이 조용히 수정됐다.
        """
        _make_doc(cue_env)
        result = json.loads(update_subtitle_cues.invoke({
            "video_path": str(cue_env["video"]),
            "updates": [{"id": "c001", "end": 4.0}, {"at_ms": 3000, "text": "fix"}],
        }))
        assert result["updated"] == ["c001", "c002"]  # at_ms=3000 → 원래 c002 구간

        doc = json.loads((cue_env["subs"] / "sample.cues.json").read_text(encoding="utf-8"))
        by_id = {c["id"]: c for c in doc["cues"]}
        assert by_id["c002"]["text"] == "fix"
        assert by_id["c001"]["text"] == "첫번째 자막"  # 오염되지 않음
        assert by_id["c001"]["end"] == 4.0

    def test_update_after_delete_of_same_cue_reports_failed(self, cue_env):
        """같은 배치에서 삭제된 큐를 다시 수정하면 조용히 넘어가지 않고 failed."""
        _make_doc(cue_env)
        result = json.loads(update_subtitle_cues.invoke({
            "video_path": str(cue_env["video"]),
            "updates": [{"id": "c002", "delete": True}, {"id": "c002", "text": "좀비"}],
        }))
        assert result["deleted"] == ["c002"]
        assert result["updated"] == []
        assert result["failed"][0]["id"] == "c002"

        doc = json.loads((cue_env["subs"] / "sample.cues.json").read_text(encoding="utf-8"))
        assert [c["id"] for c in doc["cues"]] == ["c001", "c003"]


# =============================================================
# add_subtitle_cue
# =============================================================

class TestAddCue:
    def test_insert_sorted_with_new_id(self, cue_env):
        _make_doc(cue_env)
        # c002 삭제 후 추가 → 삭제된 번호 재사용 금지 (id_seq 기반 c004)
        update_subtitle_cues.invoke({
            "video_path": str(cue_env["video"]),
            "updates": [{"id": "c002", "delete": True}],
        })
        result = json.loads(add_subtitle_cue.invoke({
            "video_path": str(cue_env["video"]),
            "start": 2.0,
            "end": 4.0,
            "text": "새 자막",
            "style": json.dumps({"position": "top"}),
        }))
        assert result["status"] == "success"
        assert result["id"] == "c004"

        doc = json.loads((cue_env["subs"] / "sample.cues.json").read_text(encoding="utf-8"))
        # 시간순 정렬: c001(0-2), c004(2-4), c003(4.5-6)
        assert [c["id"] for c in doc["cues"]] == ["c001", "c004", "c003"]
        assert doc["cues"][1]["style"] == {"position": "top"}


# =============================================================
# set_subtitle_style
# =============================================================

class TestSetStyle:
    def test_defaults_scope_merges_style_defaults(self, cue_env):
        _make_doc(cue_env)
        result = json.loads(set_subtitle_style.invoke({
            "video_path": str(cue_env["video"]),
            "style": json.dumps({"position": "top", "size": 32}),
        }))
        assert result["status"] == "success"
        assert result["style_defaults"]["position"] == "top"
        assert result["style_defaults"]["size"] == 32
        # 기존 키 유지
        assert result["style_defaults"]["color"] == "#FFFFFF"

        doc = json.loads((cue_env["subs"] / "sample.cues.json").read_text(encoding="utf-8"))
        assert all("style" not in c or "position" not in c.get("style", {}) for c in doc["cues"])

    def test_all_cues_scope_merges_into_each_cue(self, cue_env):
        _make_doc(cue_env)
        # c001 에 기존 오버라이드
        update_subtitle_cues.invoke({
            "video_path": str(cue_env["video"]),
            "updates": [{"id": "c001", "style": {"color": "#FF0000"}}],
        })
        result = json.loads(set_subtitle_style.invoke({
            "video_path": str(cue_env["video"]),
            "style": json.dumps({"size": 30}),
            "scope": "all_cues",
        }))
        assert result["applied_cues"] == 3

        doc = json.loads((cue_env["subs"] / "sample.cues.json").read_text(encoding="utf-8"))
        assert doc["cues"][0]["style"] == {"color": "#FF0000", "size": 30}
        assert doc["cues"][1]["style"] == {"size": 30}

    def test_defaults_scope_fade_reaches_render(self, cue_env):
        """[회귀] set_subtitle_style(style='{"fade":true}') 가 조용한 no-op 이면 안 됨.

        "모든 자막에 페이드" 요청의 실제 경로 — 저장만 되고 ASS 에 반영 안 됐었다.
        """
        _make_doc(cue_env)
        result = json.loads(set_subtitle_style.invoke({
            "video_path": str(cue_env["video"]),
            "style": json.dumps({"fade": True}),
        }))
        assert result["status"] == "success"
        assert result["style_defaults"]["fade"] is True

        with patch("agent.tools.subtitle_cues.subprocess.run") as mock_run:
            mock_run.side_effect = _fake_subprocess_run
            assert not render_subtitles.invoke(
                {"video_path": str(cue_env["video"])}
            ).startswith("ERROR")

        ass_text = (cue_env["subs"] / "sample.ass").read_text(encoding="utf-8")
        dialogues = [ln for ln in ass_text.splitlines() if ln.startswith("Dialogue:")]
        assert len(dialogues) == 3
        assert all("\\fad(200,200)" in ln for ln in dialogues)

    def test_unknown_font_returns_error_with_inventory(self, cue_env):
        _make_doc(cue_env)
        result = set_subtitle_style.invoke({
            "video_path": str(cue_env["video"]),
            "style": json.dumps({"font": "ComicSans"}),
        })
        assert result.startswith("ERROR")
        assert "ComicSans" in result
        assert "NotoSansKR" in result  # 현재 보유 목록


# =============================================================
# ASS 빌더
# =============================================================

class TestAssBuilder:
    def test_color_to_ass_bgr_order(self):
        # #FFE600 → R=FF G=E6 B=00 → BGR = 00 E6 FF
        assert _color_to_ass("#FFE600") == "&H00E6FF"
        assert _color_to_ass("#FFE600", alpha="00") == "&H0000E6FF"
        assert _color_to_ass("yellow") == "&H00FFFF"
        with pytest.raises(ValueError):
            _color_to_ass("notacolor")

    def test_build_ass_defaults_and_inline_tags(self, cue_env):
        doc = {
            "version": 1,
            "video_stem": "sample",
            "source_video": str(cue_env["video"]),
            "style_defaults": {**subtitle_cues.DEFAULT_STYLE, "size": 24},
            "cues": [
                {"id": "c001", "start": 1.2, "end": 3.4, "text": "안녕하세요",
                 "style": {"color": "#FFE600", "size": 30, "bold": True,
                           "position": "top", "fade": True}},
                {"id": "c002", "start": 3.4, "end": 5.0, "text": "일반 큐"},
            ],
        }
        ass = subtitle_cues._build_ass(doc)

        # PlayRes 는 실제 해상도가 아니라 고정 384x288 (레거시 force_style 경로와 동일)
        assert "PlayResX: 384" in ass
        assert "PlayResY: 288" in ass
        assert "Style: Default,NotoSansKR,24," in ass
        # per-cue 인라인 태그
        assert "\\an8" in ass          # top
        assert "\\fs30" in ass
        assert "\\b1" in ass
        assert "\\1c&H00E6FF&" in ass  # #FFE600 → BGR
        assert "\\fad(200,200)" in ass
        # 오버라이드 없는 큐엔 태그 없음
        assert ",,일반 큐" in ass
        assert "0:00:01.20" in ass and "0:00:03.40" in ass

    def test_an_mapping_nine_directions(self):
        assert subtitle_cues._AN_MAP["bottom"] == 2
        assert subtitle_cues._AN_MAP["center"] == 5
        assert subtitle_cues._AN_MAP["top"] == 8
        assert subtitle_cues._AN_MAP["top-left"] == 7
        assert subtitle_cues._AN_MAP["bottom-right"] == 3

    def test_playres_matches_legacy_force_style_canvas(self, cue_env):
        """[회귀] PlayRes 고정 384x288 — 실제 해상도를 쓰면 자막이 1/3.75 로 작아짐.

        FFmpeg 이 SRT → ASS 변환에 쓰는 기본 캔버스와 동일해야 subtitle.py 의
        force_style 번인 경로와 같은 크기로 렌더된다.
        """
        _make_doc(cue_env)
        doc = json.loads((cue_env["subs"] / "sample.cues.json").read_text(encoding="utf-8"))
        ass = subtitle_cues._build_ass(doc)

        assert f"PlayResX: {subtitle_cues.PLAY_RES_X}" in ass
        assert f"PlayResY: {subtitle_cues.PLAY_RES_Y}" in ass
        assert (subtitle_cues.PLAY_RES_X, subtitle_cues.PLAY_RES_Y) == (384, 288)
        # 스타일 값은 288 기준 그대로 (스케일 보정 없음)
        assert "Style: Default,NotoSansKR,24," in ass
        assert ",1.5,0,2,10,10,40,1" in ass  # stroke_width / alignment / margin_v

    def test_portrait_long_text_clamps_oversized_font(self, cue_env):
        """LLM이 48을 지정해도 긴 세로 자막이 화면 대부분을 가리면 안 된다."""
        doc = {
            "version": 1,
            "video_stem": "sample",
            "source_video": str(cue_env["video"]),
            "style_defaults": {**subtitle_cues.DEFAULT_STYLE, "size": 48},
            "cues": [{
                "id": "c001",
                "start": 0.0,
                "end": 4.0,
                "text": "오늘 이걸 분해하고 자려고 했는데 내일 가야겠군요.",
            }],
        }

        ass = subtitle_cues._build_ass(doc, video_size=(720, 1280))
        style_line = next(
            line for line in ass.splitlines() if line.startswith("Style: Default")
        )
        rendered_size = float(style_line.split(",")[2])

        assert "PlayResX: 162" in ass
        assert 10 <= rendered_size <= 18

    def test_defaults_fade_applies_to_cues_without_override(self, cue_env):
        """[회귀] scope='defaults' 의 fade 가 렌더에서 무시되면 안 됨."""
        doc = {
            "version": 1,
            "video_stem": "sample",
            "source_video": str(cue_env["video"]),
            "style_defaults": {**subtitle_cues.DEFAULT_STYLE, "fade": True},
            "cues": [
                {"id": "c001", "start": 0.0, "end": 1.0, "text": "기본 페이드"},
                {"id": "c002", "start": 1.0, "end": 2.0, "text": "페이드 끔",
                 "style": {"fade": False}},
                {"id": "c003", "start": 2.0, "end": 3.0, "text": "다른 오버라이드",
                 "style": {"size": 30}},
            ],
        }
        lines = [ln for ln in subtitle_cues._build_ass(doc).splitlines()
                 if ln.startswith("Dialogue:")]

        assert "\\fad(200,200)" in lines[0]      # 오버라이드 없음 → defaults 적용
        assert "\\fad(200,200)" not in lines[1]  # fade:false 는 존중
        assert "\\fad(200,200)" in lines[2]      # 다른 키 오버라이드는 fade 를 막지 않음
        assert "\\fs30" in lines[2]

    def test_defaults_fade_absent_means_no_fade(self, cue_env):
        _make_doc(cue_env)
        doc = json.loads((cue_env["subs"] / "sample.cues.json").read_text(encoding="utf-8"))
        assert "\\fad" not in subtitle_cues._build_ass(doc)

    def test_explicit_zero_margin_is_not_swallowed_by_ass_inherit(self, cue_env):
        """ASS MarginV=0 은 '스타일 기본값 사용' 이라 명시적 0 은 1 로 클램프."""
        doc = {
            "version": 1,
            "video_stem": "sample",
            "source_video": str(cue_env["video"]),
            "style_defaults": {**subtitle_cues.DEFAULT_STYLE, "margin_v": 40},
            "cues": [
                {"id": "c001", "start": 0.0, "end": 1.0, "text": "오버라이드 없음"},
                {"id": "c002", "start": 1.0, "end": 2.0, "text": "명시적 0",
                 "style": {"margin_v": 0}},
                {"id": "c003", "start": 2.0, "end": 3.0, "text": "명시적 60",
                 "style": {"margin_v": 60}},
            ],
        }
        lines = [ln for ln in subtitle_cues._build_ass(doc).splitlines()
                 if ln.startswith("Dialogue:")]

        assert lines[0].split(",")[7] == "0"   # 오버라이드 없음 → Style 상속
        assert lines[1].split(",")[7] == "1"   # 명시적 0 → 1 (기본 40 으로 되돌아가지 않음)
        assert lines[2].split(",")[7] == "60"


# =============================================================
# render_subtitles
# =============================================================

def _fake_subprocess_run(cmd, *args, **kwargs):
    """ffprobe 는 해상도 JSON, ffmpeg 는 출력 파일 생성."""
    if cmd[0] == "ffprobe":
        return MagicMock(
            returncode=0,
            stdout=json.dumps({"streams": [{"width": 1920, "height": 1080}]}),
            stderr="",
        )
    output = Path(cmd[-1])
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(b"fake_render")
    return MagicMock(returncode=0, stdout="", stderr="")


class TestRenderSubtitles:
    def test_origin_and_pad_sidecars_are_preserved(self, cue_env):
        """자막 번인 뒤에도 원본 시간축과 letterbox 메타가 이어져야 한다."""
        source = cue_env["tmp"] / "source.mp4"
        source.write_bytes(b"original")
        (Path(str(source) + ".origin.json")).write_text(
            json.dumps({"clips": [{"source": "a.mp4"}]}), encoding="utf-8"
        )
        (Path(str(source) + ".pad.json")).write_text(
            json.dumps({"content_area": [0, 10, 100, 80]}), encoding="utf-8"
        )
        _make_doc(cue_env, source=source)
        output = cue_env["outputs"] / "final.mp4"

        with patch("agent.tools.subtitle_cues.subprocess.run") as mock_run:
            mock_run.side_effect = _fake_subprocess_run
            result = render_subtitles.invoke({
                "video_path": str(cue_env["video"]),
                "output_path": str(output),
            })

        assert result == str(output)
        assert Path(str(output) + ".origin.json").exists()
        assert Path(str(output) + ".pad.json").exists()

    def test_renders_from_source_video_not_input(self, cue_env):
        """이미 번인된 파일이 아니라 문서의 source_video 로 렌더해야 함."""
        source = cue_env["tmp"] / "sample_source.mp4"
        source.write_bytes(b"original")
        _make_doc(cue_env, source=source)

        burned = cue_env["tmp"] / "sample.mp4"  # 큐 문서 stem 과 동일
        with patch("agent.tools.subtitle_cues.subprocess.run") as mock_run:
            mock_run.side_effect = _fake_subprocess_run
            result = render_subtitles.invoke({"video_path": str(burned)})

        assert not result.startswith("ERROR"), result
        assert result.endswith(".mp4")

        ffmpeg_calls = [c for c in mock_run.call_args_list if c[0][0][0] == "ffmpeg"]
        assert len(ffmpeg_calls) == 1
        cmd = ffmpeg_calls[0][0][0]
        assert cmd[cmd.index("-i") + 1] == str(source)  # source_video 기준

        vf = cmd[cmd.index("-vf") + 1]
        assert "sample.ass" in vf
        assert "fontsdir" in vf
        ass_text = (cue_env["subs"] / "sample.ass").read_text(encoding="utf-8")
        assert "PlayResX: 384" in ass_text

    def test_output_path_and_default_naming(self, cue_env):
        _make_doc(cue_env)
        with patch("agent.tools.subtitle_cues.subprocess.run") as mock_run:
            mock_run.side_effect = _fake_subprocess_run
            result = render_subtitles.invoke({"video_path": str(cue_env["video"])})

        assert result.startswith(str(cue_env["outputs"]))
        assert "sample_subtitled_" in result

    def test_missing_font_blocks_render(self, cue_env):
        _make_doc(cue_env, style_defaults={"font": "MissingFont"})
        with patch("agent.tools.subtitle_cues.subprocess.run") as mock_run:
            result = render_subtitles.invoke({"video_path": str(cue_env["video"])})

        assert result.startswith("ERROR")
        assert "MissingFont" in result
        mock_run.assert_not_called()

    def test_missing_source_video_error(self, cue_env):
        ghost = cue_env["tmp"] / "ghost_source.mp4"
        _make_doc(cue_env, source=ghost)
        result = render_subtitles.invoke({"video_path": str(cue_env["video"])})
        assert result.startswith("ERROR")
        assert "source_video" in result


# =============================================================
# TTS
# =============================================================

@pytest.fixture
def tts_env(tmp_path):
    audio_dir = tmp_path / "audio_files"
    with ExitStack() as stack:
        stack.enter_context(patch("agent.tools.tts.ELEVENLABS_API_KEY", "test-key"))
        stack.enter_context(patch("agent.tools.tts.ELEVENLABS_DEFAULT_VOICE_ID", "env-voice-id"))
        stack.enter_context(patch("agent.tools.tts.AUDIO_DIR", audio_dir))
        mock_post = stack.enter_context(patch("agent.tools.tts.requests.post"))
        mock_post.return_value = MagicMock(status_code=200, content=b"fake_mp3")
        yield {"tmp": tmp_path, "audio_dir": audio_dir, "post": mock_post}


class TestTextToSpeech:
    def test_voice_settings_params_forwarded(self, tts_env):
        out = tts_env["tmp"] / "narration.mp3"
        result = json.loads(text_to_speech.invoke({
            "text": "차분한 나래이션",
            "voice": "raw-voice-id",
            "stability": 0.8,
            "style": 0.3,
            "speed": 0.9,
            "output_path": str(out),
        }))

        assert result["status"] == "success"
        payload = tts_env["post"].call_args.kwargs["json"]
        assert payload["voice_settings"] == {
            "stability": 0.8,
            "similarity_boost": 0.75,
            "style": 0.3,
            "speed": 0.9,
        }
        assert out.read_bytes() == b"fake_mp3"

    def test_default_settings_omit_style_and_speed(self, tts_env):
        result = json.loads(text_to_speech.invoke({"text": "기본 설정"}))
        assert result["status"] == "success"
        payload = tts_env["post"].call_args.kwargs["json"]
        assert payload["voice_settings"] == {"stability": 0.5, "similarity_boost": 0.75}

    def test_catalog_voice_resolves_to_env_default(self, tts_env):
        """카탈로그 id (male_ko_general) → env:ELEVENLABS_DEFAULT_VOICE_ID 해석."""
        result = json.loads(text_to_speech.invoke({
            "text": "카탈로그 보이스",
            "voice": "male_ko_general",
        }))
        assert result["status"] == "success"
        assert result["catalog_voice"] == "male_ko_general"
        url = tts_env["post"].call_args.args[0]
        assert url.endswith("/env-voice-id")

    def test_catalog_voice_without_mapping_errors(self, tts_env, tmp_path):
        catalog = tmp_path / "voices.json"
        catalog.write_text(
            json.dumps({"voices": [{"id": "test_voice"}]}), encoding="utf-8"
        )
        with patch("agent.tools.tts.VOICES_PATH", catalog), \
             patch("agent.tools.tts.ELEVENLABS_DEFAULT_VOICE_ID", None):
            result = json.loads(text_to_speech.invoke({
                "text": "매핑 없음",
                "voice": "test_voice",
            }))
        assert result["status"] == "error"
        assert "elevenlabs_voice_id" in result["error"]
        tts_env["post"].assert_not_called()

    def test_narration_manifest_appends(self, tts_env):
        """같은 output_path 로 낸 나래이션은 그 stem 의 manifest 에 순서대로 append."""
        out = tts_env["tmp"] / "intro.mp3"
        for text in ("첫 나래이션", "둘째 나래이션"):
            result = json.loads(text_to_speech.invoke({
                "text": text, "output_path": str(out),
            }))
            assert result["status"] == "success"

        manifest_path = Path(result["manifest"])
        assert manifest_path == tts_env["audio_dir"] / "intro.narration.json"
        entries = json.loads(manifest_path.read_text(encoding="utf-8"))
        assert [e["id"] for e in entries] == ["n001", "n002"]
        assert entries[0]["text"] == "첫 나래이션"
        assert entries[0]["params"] == {"stability": 0.5, "similarity_boost": 0.75}
        assert "file" in entries[0] and "created_at_epoch" in entries[0]

    def test_default_output_does_not_share_one_session_manifest(self, tts_env):
        """[회귀] 기본 키가 상수 "session" 이면 모든 세션/영상 나래이션이 섞임."""
        first = json.loads(text_to_speech.invoke({"text": "세션 A 나래이션"}))
        second = json.loads(text_to_speech.invoke({"text": "세션 B 나래이션"}))

        assert not (tts_env["audio_dir"] / "session.narration.json").exists()
        assert first["output"] != second["output"]      # 같은 초에도 경로 충돌 없음
        assert first["manifest"] != second["manifest"]  # manifest 도 분리

        for result, text in ((first, "세션 A 나래이션"), (second, "세션 B 나래이션")):
            entries = json.loads(Path(result["manifest"]).read_text(encoding="utf-8"))
            assert [e["text"] for e in entries] == [text]
            assert Path(result["manifest"]).stem.removesuffix(".narration") == \
                Path(result["output"]).stem

    def test_parallel_appends_do_not_lose_entries(self, tts_env):
        """[회귀] ToolNode 병렬 스레드의 read-modify-write 로 항목이 유실되면 안 됨."""
        out = tts_env["tmp"] / "narration.mp3"
        texts = [f"나래이션 {i}" for i in range(12)]
        errors: list = []

        def worker(text: str):
            try:
                result = json.loads(text_to_speech.invoke({
                    "text": text, "output_path": str(out),
                }))
                assert result["status"] == "success"
            except Exception as error:  # 스레드 예외를 메인으로 전달
                errors.append(error)

        threads = [threading.Thread(target=worker, args=(t,)) for t in texts]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert errors == []
        entries = json.loads(
            (tts_env["audio_dir"] / "narration.narration.json").read_text(encoding="utf-8")
        )
        assert len(entries) == len(texts)
        assert sorted(e["text"] for e in entries) == sorted(texts)
        # id 는 append 순서대로 중복 없이 발급
        assert [e["id"] for e in entries] == [f"n{i:03d}" for i in range(1, len(texts) + 1)]


# =============================================================
# mix_audio at_time_ms
# =============================================================

class TestMixAudioOffset:
    def test_audio_mix_preserves_origin_and_pad_sidecars(self, tmp_path):
        video = tmp_path / "v.mp4"
        audio = tmp_path / "a.mp3"
        output = tmp_path / "o.mp4"
        video.write_bytes(b"v")
        audio.write_bytes(b"a")
        Path(f"{video}.origin.json").write_text('{"clips":[]}', encoding="utf-8")
        Path(f"{video}.pad.json").write_text('{"x":0}', encoding="utf-8")

        with patch("agent.tools.audio_mix.run_ffmpeg"):
            result = json.loads(mix_audio.invoke({
                "video_path": str(video),
                "audio_path": str(audio),
                "output_path": str(output),
            }))

        assert result["status"] == "success"
        assert Path(f"{output}.origin.json").exists()
        assert Path(f"{output}.pad.json").exists()

    def test_overlay_with_offset_uses_adelay(self, tmp_path):
        video = tmp_path / "v.mp4"
        audio = tmp_path / "a.mp3"
        video.write_bytes(b"v")
        audio.write_bytes(b"a")
        out = tmp_path / "o.mp4"

        with patch("agent.tools.audio_mix.run_ffmpeg") as mock_run:
            result = json.loads(mix_audio.invoke({
                "video_path": str(video),
                "audio_path": str(audio),
                "mode": "overlay",
                "output_path": str(out),
                "at_time_ms": 2500,
            }))

        assert result["status"] == "success"
        assert result["at_time_ms"] == 2500
        cmd = mock_run.call_args[0]
        audio_filter = cmd[cmd.index("-filter_complex") + 1]
        # all=1 — "2500|2500" 은 앞 2채널만 지연시켜 다채널 오디오가 어긋남
        assert "adelay=2500:all=1" in audio_filter
        assert "|" not in audio_filter
        assert "amix=inputs=2" in audio_filter

    def test_overlay_without_offset_keeps_plain_amix(self, tmp_path):
        video = tmp_path / "v.mp4"
        audio = tmp_path / "a.mp3"
        video.write_bytes(b"v")
        audio.write_bytes(b"a")

        with patch("agent.tools.audio_mix.run_ffmpeg") as mock_run:
            result = json.loads(mix_audio.invoke({
                "video_path": str(video),
                "audio_path": str(audio),
                "mode": "overlay",
                "output_path": str(tmp_path / "o.mp4"),
            }))

        assert result["status"] == "success"
        cmd = mock_run.call_args[0]
        audio_filter = cmd[cmd.index("-filter_complex") + 1]
        # 오프셋이 없어도 나레이션 볼륨 밸런싱(원본 0.85 / 오버레이 1.0) + 리미터가
        # 걸린다. adelay 만 없다.
        assert "adelay" not in audio_filter
        assert audio_filter == (
            "[0:a]volume=0.85[src];[1:a]volume=1.0[ovl];"
            "[src][ovl]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[mix]"
        )
