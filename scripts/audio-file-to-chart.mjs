import { spawnSync } from "node:child_process";
import path from "node:path";
import { generateAudioChart } from "../src/audio-chart-generator.js";

const SAMPLE_RATE = 44100;
const MAX_DECODED_BYTES = 512 * 1024 * 1024;

export function decodeAudioFile(inputPath) {
  const result = spawnSync(
    "ffmpeg",
    ["-v", "error", "-i", inputPath, "-f", "f32le", "-ac", "1", "-ar", String(SAMPLE_RATE), "pipe:1"],
    { encoding: null, maxBuffer: MAX_DECODED_BYTES },
  );

  if (result.error?.code === "ENOENT") {
    throw new Error("FFmpeg를 찾지 못했습니다. FFmpeg를 설치하고 PATH에 추가해 주세요.");
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr?.toString().trim();
    throw new Error(detail || "FFmpeg가 오디오 파일을 디코딩하지 못했습니다.");
  }

  const pcm = result.stdout;
  const samples = new Float32Array(
    pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength),
  );

  return {
    sampleRate: SAMPLE_RATE,
    length: samples.length,
    duration: samples.length / SAMPLE_RATE,
    numberOfChannels: 1,
    getChannelData: () => samples,
  };
}

export function generateChartFromAudioFile(inputPath, options = {}) {
  const resolvedInput = path.resolve(inputPath);
  const audioBuffer = decodeAudioFile(resolvedInput);
  return generateAudioChart(audioBuffer, {
    difficulty: options.difficulty || "standard",
    sourceFile: options.sourceFile || path.basename(resolvedInput),
  });
}
