import assert from "node:assert/strict";
import test from "node:test";
import { generateChart, pickRecommendedTrack } from "../src/chart-generator.js";

function makeMidi() {
  return {
    duration: 2.5,
    header: { tempos: [{ bpm: 150 }] },
    tracks: [
      { name: "Conductor", channel: 0, notes: [], instrument: {} },
      {
        name: "EDM Lead",
        channel: 4,
        instrument: { percussion: false },
        notes: [
          { time: 0, duration: 0.2, midi: 60, velocity: 0.8 },
          { time: 0.01, duration: 0.2, midi: 72, velocity: 0.9 },
          { time: 0.25, duration: 0.2, midi: 64, velocity: 0.7 },
          { time: 0.5, duration: 0.7, midi: 67, velocity: 0.75 },
        ],
      },
    ],
  };
}

test("lead 이름을 가진 트랙을 기본 채보로 선택한다", () => {
  assert.equal(pickRecommendedTrack(makeMidi()), 1);
});

test("4레인 채보와 안정적인 메타데이터를 생성한다", () => {
  const chart = generateChart(makeMidi(), { sourceFile: "fixture.mid", difficulty: "standard" });
  assert.equal(chart.meta.bpm, 150);
  assert.equal(chart.meta.sourceTrack, "EDM Lead");
  assert.equal(chart.meta.laneCount, 4);
  assert.ok(chart.meta.audioStart >= 0);
  assert.ok(chart.notes.length >= 3);
  assert.ok(chart.notes.every((note) => note.lane >= 0 && note.lane <= 3));
  assert.ok(chart.notes.every((note) => ["tap", "hold"].includes(note.type)));
  assert.ok(chart.notes.every((note) => note.endTime === Number((note.time + note.duration).toFixed(4))));
  assert.equal(chart.meta.holdNoteCount, 1);
  assert.deepEqual(chart.meta.keys, ["D", "F", "J", "K"]);
});

test("calm 난이도는 expert보다 노트를 더 많이 만들지 않는다", () => {
  const midi = makeMidi();
  const calm = generateChart(midi, { difficulty: "calm" });
  const expert = generateChart(midi, { difficulty: "expert" });
  assert.ok(calm.notes.length <= expert.notes.length);
});
