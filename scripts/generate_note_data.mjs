import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import midiPackage from "@tonejs/midi";
import {
  chartToJson,
  generateChart,
  listPlayableTracks,
  pickRecommendedTrack,
} from "../src/chart-generator.js";

const { Midi } = midiPackage;

const [, , inputArg, outputArg, difficultyArg = "standard", trackArg] = process.argv;

if (!inputArg) {
  console.error(
    "사용법: node scripts/generate_note_data.mjs <input.mid> [output.json] [calm|standard|expert] [track index|name]",
  );
  process.exit(1);
}

const inputPath = path.resolve(inputArg);
const outputPath = path.resolve(
  outputArg || path.join("output", `${path.basename(inputPath, path.extname(inputPath))}.chart.json`),
);
const midi = new Midi(await readFile(inputPath));
const tracks = listPlayableTracks(midi);

let trackIndex = pickRecommendedTrack(midi);
if (trackArg) {
  const numeric = Number(trackArg);
  const named = tracks.find((track) => track.name.toLowerCase() === trackArg.toLowerCase());
  if (Number.isInteger(numeric) && midi.tracks[numeric]?.notes.length) trackIndex = numeric;
  else if (named) trackIndex = named.index;
  else throw new Error(`트랙을 찾지 못했습니다: ${trackArg}`);
}

const chart = generateChart(midi, {
  difficulty: difficultyArg,
  trackIndex,
  sourceFile: path.basename(inputPath),
});

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, chartToJson(chart), "utf8");

console.log(
  JSON.stringify(
    {
      input: inputPath,
      output: outputPath,
      track: chart.meta.sourceTrack,
      difficulty: chart.meta.difficulty,
      bpm: chart.meta.bpm,
      notes: chart.notes.length,
      duration: chart.meta.duration,
    },
    null,
    2,
  ),
);
