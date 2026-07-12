"use client";

// Curve3DSection — 3D 커브드 캔버스 공용 컨트롤. 씬/그룹·frame/개별 요소가 같은
// curve3d 스펙을 쓰므로 인스펙터 섹션도 하나로 일반화(write/remove 콜백만 주입).
// amount 부호 = 볼록(+)/오목(-). profile = 전체 원호 vs 끝만 굴곡. edgeBlur = 가장자리 블러.

import React from "react";
import type { Curve3DSpec } from "@engine/motion/curve3d";
import { Section, Row, NumberInput, Select, Toggle } from "@/editor/controls";

export function Curve3DSection({
  curve,
  write,
  remove,
}: {
  curve: Curve3DSpec | undefined;
  /** "curve3d.<field>" 를 쓰는 콜백 (live=드래그 coalesce). */
  write: (field: string, v: unknown, live: boolean) => void;
  /** curve3d 전체 제거. */
  remove: () => void;
}) {
  const on = !!curve;
  return (
    <Section title="3D Canvas" defaultOpen={on}>
      <Row label="Enable">
        <Toggle
          on={on}
          onChange={(v) => {
            if (v) write("amount", 30, false); // 기본 볼록 30deg 로 시작
            else remove();
          }}
          aria-label="3D canvas"
        />
      </Row>
      {on && curve && (
        <>
          <Row label="Mode">
            <Select
              value={curve.mode ?? "bend"}
              options={[
                { value: "bend", label: "Bend (면 굽힘)" },
                { value: "drum", label: "Drum (판 배치)" },
              ]}
              onChange={(v) => write("mode", v, false)}
            />
          </Row>
          {/* amount 부호 = 방향 (양수 볼록 / 음수 오목). UI 는 명시적 셀렉트 + 절대값. */}
          <Row label="Direction">
            <Select
              value={(curve.amount ?? 30) >= 0 ? "convex" : "concave"}
              options={[
                { value: "convex", label: "볼록 (튀어나옴)" },
                { value: "concave", label: "오목 (움푹 파임)" },
              ]}
              onChange={(v) =>
                write("amount", (v === "convex" ? 1 : -1) * Math.abs(curve.amount ?? 30), false)
              }
            />
          </Row>
          <Row label="Amount">
            <NumberInput
              value={Math.abs(curve.amount ?? 30)}
              min={0}
              max={80}
              step={1}
              unit="°"
              onChange={(v, o) =>
                write("amount", ((curve.amount ?? 30) >= 0 ? 1 : -1) * v, o.live)
              }
            />
          </Row>
          <Row label="Axis">
            <Select
              value={curve.axis ?? "y"}
              options={[
                { value: "y", label: "위아래로 굽음 (rows)" },
                { value: "x", label: "좌우로 굽음 (cols)" },
              ]}
              onChange={(v) => write("axis", v, false)}
            />
          </Row>
          {/* Segments 제거 — bend 는 per-pixel 워프라 조각 개념이 없다(항상 매끈). */}
          <Row label="Profile">
            <Select
              value={curve.profile ?? "arc"}
              options={[
                { value: "arc", label: "Arc (전체 굴곡)" },
                { value: "edges", label: "Edges (끝만 굴곡)" },
              ]}
              onChange={(v) => write("profile", v, false)}
            />
          </Row>
          <Row label="Edge blur">
            <NumberInput
              value={curve.edgeBlur ?? 0}
              min={0}
              max={24}
              step={0.5}
              unit="px"
              onChange={(v, o) => write("edgeBlur", v, o.live)}
            />
          </Row>
          {/* Depth 는 drum(판 배치) 기하에서만 의미 — bend 워프는 perspective 로 조절. */}
          {(curve.mode ?? "bend") === "drum" && (
            <Row label="Depth">
              <NumberInput
                value={curve.depth ?? 420}
                min={0}
                max={1200}
                step={10}
                unit="px"
                onChange={(v, o) => write("depth", v, o.live)}
              />
            </Row>
          )}
          <Row label="Perspective">
            <NumberInput
              value={curve.perspective ?? 1100}
              min={300}
              max={3000}
              step={50}
              unit="px"
              onChange={(v, o) => write("perspective", v, o.live)}
            />
          </Row>
        </>
      )}
    </Section>
  );
}
