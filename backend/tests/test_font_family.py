"""폰트 내부 family 명 파싱 (_sfnt_family_name / _font_family_from_file) 테스트.

libass 는 폰트 내부 name 테이블의 family 명으로만 매칭하므로, 파일명 stem 을
그대로 쓰면 Arial 폴백(한글 두부)이 난다. 다운로드 폰트는 git 에 없어서
합성 sfnt 바이너리로 검증한다.
"""

from __future__ import annotations

import struct

from agent.tools.subtitle import _font_family_from_file, _sfnt_family_name


def make_sfnt(names: dict[int, str]) -> bytes:
    """nameID -> 문자열 매핑만 담은 최소 TTF 바이너리 생성."""
    records = []
    strings = b""
    for nid, val in sorted(names.items()):
        raw = val.encode("utf-16-be")
        records.append((3, 1, 0x409, nid, len(raw), len(strings)))
        strings += raw
    count = len(records)
    name_table = struct.pack(">HHH", 0, count, 6 + 12 * count)
    for rec in records:
        name_table += struct.pack(">6H", *rec)
    name_table += strings

    header = struct.pack(">IHHHH", 0x00010000, 1, 16, 0, 0)
    table_rec = b"name" + struct.pack(">III", 0, 28, len(name_table))
    return header + table_rec + name_table


class TestSfntFamilyName:
    def test_reads_windows_family_name(self, tmp_path):
        font = tmp_path / "MyFont-Regular.ttf"
        font.write_bytes(make_sfnt({1: "My Font"}))
        assert _sfnt_family_name(str(font)) == "My Font"

    def test_typographic_family_wins_over_legacy(self, tmp_path):
        """nameID 16(typographic)이 있으면 1(legacy, weight 포함 가능)보다 우선."""
        font = tmp_path / "Plex.ttf"
        font.write_bytes(make_sfnt({1: "IBM Plex Sans KR Light", 16: "IBM Plex Sans KR"}))
        assert _sfnt_family_name(str(font)) == "IBM Plex Sans KR"

    def test_non_font_bytes_return_none(self, tmp_path):
        """과거 download_fonts.py 가 저장한 EOT/HTML 류 깨진 파일 → None."""
        junk = tmp_path / "Broken-Regular.ttf"
        junk.write_bytes(b"\xf4_\x00\x00" + b"junk" * 100)
        assert _sfnt_family_name(str(junk)) is None

    def test_missing_file_returns_none(self, tmp_path):
        assert _sfnt_family_name(str(tmp_path / "ghost.ttf")) is None


class TestFontFamilyFromFile:
    def test_parses_internal_name_from_fonts_dir(self, tmp_path, monkeypatch):
        import agent.tools.subtitle as sub

        monkeypatch.setattr(sub, "FONTS_DIR", str(tmp_path))
        sub._family_cache.clear()
        (tmp_path / "GothicA1-Regular.ttf").write_bytes(make_sfnt({1: "Gothic A1"}))
        assert _font_family_from_file("GothicA1-Regular.ttf") == "Gothic A1"

    def test_missing_file_falls_back_to_known_map(self, tmp_path, monkeypatch):
        import agent.tools.subtitle as sub

        monkeypatch.setattr(sub, "FONTS_DIR", str(tmp_path))
        sub._family_cache.clear()
        assert _font_family_from_file("NotoSerifKR-Bold.ttf") == "Noto Serif KR"

    def test_missing_file_falls_back_to_stem(self, tmp_path, monkeypatch):
        import agent.tools.subtitle as sub

        monkeypatch.setattr(sub, "FONTS_DIR", str(tmp_path))
        sub._family_cache.clear()
        assert _font_family_from_file("SomeFont-Bold.ttf") == "SomeFont"

    def test_broken_file_falls_back_to_stem(self, tmp_path, monkeypatch):
        import agent.tools.subtitle as sub

        monkeypatch.setattr(sub, "FONTS_DIR", str(tmp_path))
        sub._family_cache.clear()
        (tmp_path / "Fake-Regular.ttf").write_bytes(b"not a font")
        assert _font_family_from_file("Fake-Regular.ttf") == "Fake"


class TestResolveFont:
    """drawtext 계열(add_captions_batch 등)이 한글 폰트를 실제로 찾는지.

    실패 사례: 스타일에 font 가 없으면 _resolve_font("") 가
    os.path.join(FONTS_DIR, "") == FONTS_DIR 를 돌려줬고, os.path.exists 가
    디렉터리에도 True 라 그 경로가 그대로 fontfile 로 들어갔다. 호출부의
    `_resolve_font(x) or _resolve_font(기본폰트)` 에서 첫 항이 truthy 라
    기본 폰트로 못 넘어갔고, ffmpeg 는 디렉터리를 열지 못해 내장 폰트로
    그리면서 한글이 전부 □ 로 나왔다.
    """

    def _fonts(self, tmp_path, monkeypatch):
        import agent.tools.subtitle as sub

        monkeypatch.setattr(sub, "FONTS_DIR", str(tmp_path))
        sub._family_cache.clear()
        return sub

    def test_empty_name_returns_none_not_the_directory(self, tmp_path, monkeypatch):
        sub = self._fonts(tmp_path, monkeypatch)
        (tmp_path / "NotoSansKR-Regular.ttf").write_bytes(b"font")

        for blank in ("", "   ", None):
            assert sub._resolve_font(blank) is None

    def test_never_returns_a_directory(self, tmp_path, monkeypatch):
        sub = self._fonts(tmp_path, monkeypatch)
        (tmp_path / "subdir").mkdir()

        assert sub._resolve_font("subdir") is None

    def test_exact_filename_resolves(self, tmp_path, monkeypatch):
        sub = self._fonts(tmp_path, monkeypatch)
        target = tmp_path / "NotoSansKR-Regular.ttf"
        target.write_bytes(b"font")

        assert sub._resolve_font("NotoSansKR-Regular.ttf") == str(target)

    def test_family_name_with_spaces_resolves(self, tmp_path, monkeypatch):
        """스타일 카드와 LLM 은 "Noto Sans KR" 형태를 넘긴다."""
        sub = self._fonts(tmp_path, monkeypatch)
        target = tmp_path / "NotoSansKR-Regular.ttf"
        target.write_bytes(b"font")

        assert sub._resolve_font("Noto Sans KR") == str(target)
        assert sub._resolve_font("notosanskr") == str(target)

    def test_unknown_font_returns_none(self, tmp_path, monkeypatch):
        sub = self._fonts(tmp_path, monkeypatch)
        (tmp_path / "NotoSansKR-Regular.ttf").write_bytes(b"font")

        assert sub._resolve_font("존재하지않는폰트") is None

    def test_missing_font_dir_does_not_raise(self, tmp_path, monkeypatch):
        import agent.tools.subtitle as sub

        monkeypatch.setattr(sub, "FONTS_DIR", str(tmp_path / "nope"))
        sub._family_cache.clear()

        assert sub._resolve_font("Noto Sans KR") is None
