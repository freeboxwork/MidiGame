import path from "node:path";
import process from "node:process";
import { generateChartFromAudioFile } from "./audio-file-to-chart.mjs";

const input = path.resolve(process.argv[2] || "시_분.mp3");
const chart = generateChartFromAudioFile(input, {
  difficulty: process.argv[3] || "standard",
  sourceFile: path.basename(input),
});

console.log(
  JSON.stringify(
    {
      meta: chart.meta,
      noteCount: chart.notes.length,
      firstNotes: chart.notes.slice(0, 40),
    },
    null,
    2,
  ),
);
