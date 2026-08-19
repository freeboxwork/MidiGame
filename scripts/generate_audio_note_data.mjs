import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { AUDIO_DIFFICULTY_PRESETS } from "../src/audio-chart-generator.js";
import { chartToJson } from "../src/chart-generator.js";
import { generateChartFromAudioFile } from "./audio-file-to-chart.mjs";

const [, , inputArg, outputArg, difficultyArg = "standard"] = process.argv;

if (!inputArg) {
  console.error(
    "사용법: node scripts/generate_audio_note_data.mjs <input.mp3> [output.json] [calm|standard|expert]",
  );
  process.exit(1);
}

if (!AUDIO_DIFFICULTY_PRESETS[difficultyArg]) {
  console.error(`지원하지 않는 난이도입니다: ${difficultyArg}`);
  process.exit(1);
}

try {
  const inputPath = path.resolve(inputArg);
  const outputPath = path.resolve(
    outputArg ||
      path.join(
        "output",
        `${path.basename(inputPath, path.extname(inputPath))}.${difficultyArg}.chart.json`,
      ),
  );
  const chart = generateChartFromAudioFile(inputPath, { difficulty: difficultyArg });

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, chartToJson(chart), "utf8");

  console.log(
    JSON.stringify(
      {
        input: inputPath,
        output: outputPath,
        analysisType: chart.meta.analysisType,
        difficulty: chart.meta.difficulty,
        bpm: chart.meta.bpm,
        notes: chart.notes.length,
        duration: chart.meta.duration,
        meanSnapErrorMs: chart.meta.meanSnapErrorMs,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(`MP3 채보 생성 실패: ${error.message}`);
  process.exit(1);
}
