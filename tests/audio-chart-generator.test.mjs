import assert from "node:assert/strict";
import test from "node:test";
import { generateAudioChart } from "../src/audio-chart-generator.js";

function createPulseBuffer({ duration = 12, sampleRate = 8000, interval = 0.5 } = {}) {
  const data = new Float32Array(Math.floor(duration * sampleRate));
  for (let time = 0.5; time < duration - 0.2; time += interval) {
    const start = Math.floor(time * sampleRate);
    const accent = Math.round(time / interval) % 2 === 0 ? 1 : 0.48;
    for (let offset = 0; offset < 320 && start + offset < data.length; offset += 1) {
      const envelope = Math.exp(-offset / 72);
      data[start + offset] +=
        Math.sin((Math.PI * 2 * 110 * offset) / sampleRate) * envelope * 0.8 * accent +
        (offset % 7 === 0 ? envelope * 0.22 * accent : 0);
    }
  }
  return {
    duration,
    sampleRate,
    length: data.length,
    numberOfChannels: 1,
    getChannelData: () => data,
  };
}

test("MP3 파형과 같은 오디오 버퍼에서 정렬된 4레인 채보를 만든다", () => {
  const chart = generateAudioChart(createPulseBuffer({ interval: 0.25 }), {
    difficulty: "standard",
    sourceFile: "pulse.mp3",
  });

  assert.equal(chart.meta.analysisType, "audio-onset");
  assert.equal(chart.meta.sourceTrack, "AUTO RHYTHM");
  assert.ok(chart.notes.length >= 16);
  assert.ok(chart.meta.bpm >= 100 && chart.meta.bpm <= 140);
  assert.ok(chart.notes.every((note) => note.lane >= 0 && note.lane < 4));
  assert.ok(chart.notes.every((note) => note.type === "tap"));
  assert.deepEqual(
    chart.notes.map((note) => note.time),
    [...chart.notes].sort((a, b) => a.time - b.time).map((note) => note.time),
  );
});

test("오디오 난이도에 따라 노트 밀도를 조절한다", () => {
  const audio = createPulseBuffer({ duration: 24, interval: 0.25 });
  const calm = generateAudioChart(audio, { difficulty: "calm" });
  const expert = generateAudioChart(audio, { difficulty: "expert" });
  assert.ok(calm.notes.length <= expert.notes.length);
});
