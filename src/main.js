import { Midi } from "@tonejs/midi";
import "./styles.css";
import { generateAudioChart } from "./audio-chart-generator.js";
import {
  chartToJson,
  extractMidiEvents,
  generateChart,
  listPlayableTracks,
  pickRecommendedTrack,
} from "./chart-generator.js";
import { MidiSynth } from "./midi-synth.js";
import { RhythmGame } from "./rhythm-game.js";

const ui = Object.fromEntries(
  [
    "stateDot",
    "stateText",
    "fileDropZone",
    "midiFileInput",
    "fileButton",
    "fileName",
    "fileSummary",
    "trackSelect",
    "difficultySelect",
    "generateButton",
    "exportButton",
    "selectionView",
    "gameView",
    "brandHome",
    "selectionSongTitle",
    "selectionTrackName",
    "selectionDifficulty",
    "selectionBpm",
    "selectionNotes",
    "selectionLength",
    "selectionHoldCount",
    "selectionInstruction",
    "enterGameButton",
    "backButton",
    "gameTrackLabel",
    "gameCanvas",
    "gameStage",
    "missFlash",
    "countdown",
    "judgement",
    "effectCombo",
    "stageMessage",
    "stageMessageTitle",
    "stageMessageBody",
    "scoreValue",
    "comboValue",
    "accuracyValue",
    "startButton",
    "sessionCode",
    "sessionHeadline",
    "sessionDetail",
    "eventLog",
  ].map((id) => [id, document.getElementById(id)]),
);

if (document.fonts) {
  Promise.all([
    document.fonts.load('italic 500 64px "Barlow Condensed"', "PERFECT GREAT MISS HOLD 3 2 1"),
    document.fonts.load('italic 800 180px "Barlow Condensed"', "NEON VELOCITY GAME START"),
  ]).catch(() => {});
}

let currentMidi = null;
let currentAudioBuffer = null;
let currentChart = null;
let currentEvents = [];
let currentFileName = "시_분.mp3";
let currentSourceType = "audio";
let judgementTimer = null;
let logItems = [];
let viewTransitionInProgress = false;
const activeViewTransitions = new WeakMap();
const judgementSpriteSheetUrl = "/images/judgement-sprites-v2-magenta.png";
const judgementSpriteCrops = {
  perfect: { x: 0, y: 0.16 },
  great: { x: 0.5, y: 0.16 },
  good: { x: 0, y: 0.6 },
  miss: { x: 0.5, y: 0.6 },
};
let judgementSpriteSources = null;

function canvasToPngBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

function colorizeMissSprite(context, width, height) {
  const pixels = context.getImageData(0, 0, width, height);
  const data = pixels.data;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    const luminance =
      (data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722) / 255;
    const highlight = Math.min(1, Math.max(0, (luminance - 0.72) / 0.28)) ** 2;
    const red = 120 + 125 * luminance;
    const green = 10 + 28 * luminance;
    const blue = 18 + 36 * luminance;
    data[index] = Math.round(red + (255 - red) * highlight);
    data[index + 1] = Math.round(green + (240 - green) * highlight);
    data[index + 2] = Math.round(blue + (242 - blue) * highlight);
  }
  context.putImageData(pixels, 0, 0);
}

async function preloadSpriteImage(blob) {
  const image = new Image();
  image.src = URL.createObjectURL(blob);
  await image.decode();
  return image;
}

function warmJudgementSpriteFilter(sources) {
  const warmup = document.createElement("div");
  warmup.className = "judgement-filter-warmup";
  warmup.setAttribute("aria-hidden", "true");
  Object.entries(sources).forEach(([name, source]) => {
    const label = document.createElement("span");
    label.className = "judgement-label";
    label.dataset.sprite = name;
    const image = source.color.cloneNode();
    image.className = "judgement-sprite-color";
    label.append(image);
    warmup.append(label);
  });
  document.body.append(warmup);
  warmup.getBoundingClientRect();
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function prepareJudgementSprite() {
  try {
    const image = new Image();
    image.src = judgementSpriteSheetUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const data = pixels.data;
    for (let index = 0; index < data.length; index += 4) {
      const red = data[index];
      const green = data[index + 1];
      const blue = data[index + 2];
      const magentaDominance = Math.max(0, Math.min(red, blue) - green);
      const alpha = Math.min(255, Math.max(0, (1 - magentaDominance / 190) * 255));
      const normalizedAlpha = alpha / 255;

      if (normalizedAlpha > 0.04 && normalizedAlpha < 0.99) {
        data[index] = Math.min(255, Math.max(0, (red - 242 * (1 - normalizedAlpha)) / normalizedAlpha));
        data[index + 1] = Math.min(
          255,
          Math.max(0, (green - 15 * (1 - normalizedAlpha)) / normalizedAlpha),
        );
        data[index + 2] = Math.min(
          255,
          Math.max(0, (blue - 234 * (1 - normalizedAlpha)) / normalizedAlpha),
        );
      }
      data[index + 3] = alpha;
    }
    context.putImageData(pixels, 0, 0);

    const cropWidth = Math.round(canvas.width * 0.5);
    const cropHeight = Math.round(canvas.height * 0.24);
    const entries = await Promise.all(
      Object.entries(judgementSpriteCrops).map(async ([name, crop]) => {
        const colorCanvas = document.createElement("canvas");
        colorCanvas.width = cropWidth;
        colorCanvas.height = cropHeight;
        const colorContext = colorCanvas.getContext("2d", { willReadFrequently: true });
        if (!colorContext) throw new Error("판정 스프라이트 캔버스를 만들 수 없습니다.");
        colorContext.drawImage(
          canvas,
          Math.round(canvas.width * crop.x),
          Math.round(canvas.height * crop.y),
          cropWidth,
          cropHeight,
          0,
          0,
          cropWidth,
          cropHeight,
        );
        if (name === "miss") colorizeMissSprite(colorContext, cropWidth, cropHeight);

        const whiteCanvas = document.createElement("canvas");
        whiteCanvas.width = cropWidth;
        whiteCanvas.height = cropHeight;
        const whiteContext = whiteCanvas.getContext("2d", { willReadFrequently: true });
        if (!whiteContext) throw new Error("판정 플래시 캔버스를 만들 수 없습니다.");
        whiteContext.drawImage(colorCanvas, 0, 0);
        const whitePixels = whiteContext.getImageData(0, 0, cropWidth, cropHeight);
        for (let index = 0; index < whitePixels.data.length; index += 4) {
          whitePixels.data[index] = 255;
          whitePixels.data[index + 1] = 255;
          whitePixels.data[index + 2] = 255;
        }
        whiteContext.putImageData(whitePixels, 0, 0);

        const [colorBlob, whiteBlob] = await Promise.all([
          canvasToPngBlob(colorCanvas),
          canvasToPngBlob(whiteCanvas),
        ]);
        if (!colorBlob || !whiteBlob) throw new Error("판정 스프라이트를 PNG로 변환할 수 없습니다.");
        const [color, white] = await Promise.all([
          preloadSpriteImage(colorBlob),
          preloadSpriteImage(whiteBlob),
        ]);
        return [name, { color, white }];
      }),
    );
    judgementSpriteSources = Object.fromEntries(entries);
    await warmJudgementSpriteFilter(judgementSpriteSources);
  } catch (error) {
    console.warn("판정 스프라이트 투명화 준비에 실패했습니다.", error);
  }
}

const judgementSpriteReady = prepareJudgementSprite();

const synth = new MidiSynth();
const game = new RhythmGame({
  canvas: ui.gameCanvas,
  container: ui.gameStage,
  synth,
  onUpdate: updateScore,
  onJudgement: showJudgement,
  onState: handleGameState,
  onCountdown: updateCountdown,
  onHoldState: updateHoldState,
});

function formatDuration(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function syncDifficultyPicker(value = ui.difficultySelect.value) {
  const normalizedValue = String(value).toLowerCase();
  ui.selectionDifficulty.dataset.value = normalizedValue;
  ui.selectionDifficulty.querySelectorAll("[data-difficulty]").forEach((button) => {
    const selected = button.dataset.difficulty === normalizedValue;
    button.dataset.selected = String(selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function setTransport(kind, text) {
  ui.stateDot.dataset.state = kind;
  ui.stateText.textContent = text;
}

function setMessage(title, body, visible = true) {
  ui.stageMessageTitle.textContent = title;
  ui.stageMessageBody.textContent = body;
  ui.stageMessage.hidden = !visible;
}

async function loadDefaultTrack() {
  try {
    const response = await fetch("/audio/시_분.mp3");
    if (!response.ok) throw new Error(`기본 MP3 요청 실패 (${response.status})`);
    await loadAudioBuffer(await response.arrayBuffer(), "시_분.mp3");
  } catch (error) {
    handleError(error, "기본 곡을 불러오지 못했습니다");
  }
}

async function loadSelectedFile(file) {
  if (/\.(mid|midi)$/i.test(file.name)) {
    await loadMidiFile(file);
    return;
  }
  if (/\.mp3$/i.test(file.name)) {
    await loadAudioFile(file);
    return;
  }
  handleError(
    new Error(".mid, .midi 또는 .mp3 파일을 선택해 주세요."),
    "지원하지 않는 파일입니다",
  );
}

async function loadMidiFile(file) {
  try {
    setTransport("loading", "MIDI 분석 중");
    setMessage("새 MIDI를 분석하고 있습니다", "트랙과 템포를 읽는 중입니다.");
    await loadMidiBuffer(await file.arrayBuffer(), file.name);
  } catch (error) {
    handleError(error, "MIDI를 읽지 못했습니다");
  }
}

async function loadAudioFile(file) {
  try {
    setTransport("loading", "MP3 파형 분석 중");
    setMessage("새 MP3를 분석하고 있습니다", "박자와 타격 지점을 찾는 중입니다.");
    await loadAudioBuffer(await file.arrayBuffer(), file.name);
  } catch (error) {
    handleError(error, "MP3를 분석하지 못했습니다");
  }
}

async function decodeAudioBuffer(arrayBuffer) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("이 브라우저는 MP3 디코딩을 지원하지 않습니다.");
  const decoder = new AudioContextClass({ latencyHint: "playback" });
  try {
    return await decoder.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    decoder.close().catch(() => {});
  }
}

async function loadAudioBuffer(arrayBuffer, fileName) {
  game.stop(false);
  setTransport("loading", "MP3 디코딩 중");
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const audioBuffer = await decodeAudioBuffer(arrayBuffer);

  currentMidi = null;
  currentAudioBuffer = audioBuffer;
  currentEvents = [];
  currentFileName = fileName;
  currentSourceType = "audio";
  synth.setBackingTrack(audioBuffer, 0);
  ui.fileName.textContent = fileName;
  ui.fileSummary.textContent = `MP3 · ${formatDuration(audioBuffer.duration)} · ${(audioBuffer.sampleRate / 1000).toFixed(1)} kHz`;
  ui.trackSelect.replaceChildren();
  const option = document.createElement("option");
  option.value = "audio";
  option.textContent = "AUTO RHYTHM · waveform analysis";
  ui.trackSelect.append(option);
  ui.trackSelect.disabled = true;
  ui.generateButton.disabled = false;
  setTransport("loading", "리듬 포인트 분석 중");
  await new Promise((resolve) => requestAnimationFrame(resolve));
  buildChart();
}

async function loadMidiBuffer(buffer, fileName) {
  game.stop(false);
  const midi = new Midi(buffer);
  const tracks = listPlayableTracks(midi);
  if (!tracks.length) throw new Error("이 MIDI에는 Note On 이벤트가 없습니다.");

  currentMidi = midi;
  currentAudioBuffer = null;
  currentEvents = extractMidiEvents(midi);
  currentFileName = fileName;
  currentSourceType = "midi";
  synth.setBackingTrack(null);
  ui.fileName.textContent = fileName;
  ui.fileSummary.textContent = `${midi.tracks.length} tracks · ${currentEvents.length.toLocaleString("ko-KR")} MIDI notes`;

  ui.trackSelect.replaceChildren();
  for (const track of tracks) {
    const option = document.createElement("option");
    option.value = String(track.index);
    option.textContent = `${track.name} · ${track.noteCount} notes${track.percussion ? " · drums" : ""}`;
    ui.trackSelect.append(option);
  }
  ui.trackSelect.value = String(pickRecommendedTrack(midi));
  ui.trackSelect.disabled = false;
  ui.generateButton.disabled = false;
  buildChart();
}

function buildChart() {
  if (!currentMidi && !currentAudioBuffer) return;
  try {
    if (currentSourceType === "audio") {
      currentChart = generateAudioChart(currentAudioBuffer, {
        difficulty: ui.difficultySelect.value,
        sourceFile: currentFileName,
      });
      currentEvents = [];
      synth.setBackingTrack(currentAudioBuffer, currentChart.meta.audioStart);
    } else {
      currentChart = generateChart(currentMidi, {
        trackIndex: Number(ui.trackSelect.value),
        difficulty: ui.difficultySelect.value,
        sourceFile: currentFileName,
      });
      currentEvents = extractMidiEvents(currentMidi, currentChart.meta.audioStart);
      synth.setBackingTrack(null);
    }
    game.setChart(currentChart);
    ui.exportButton.disabled = false;
    ui.startButton.disabled = false;
    ui.enterGameButton.disabled = false;
    ui.startButton.firstChild.textContent = "다시 시작 ";
    const songName = currentFileName
      .replace(/\.(mid|midi|mp3)$/i, "")
      .replace(/[_-]+/g, " ")
      .trim()
      .toUpperCase();
    ui.selectionSongTitle.textContent = songName || "UNTITLED SEQUENCE";
    ui.selectionTrackName.textContent = currentChart.meta.sourceTrack;
    syncDifficultyPicker(currentChart.meta.difficulty);
    ui.selectionBpm.textContent = String(currentChart.meta.bpm);
    ui.selectionNotes.textContent = currentChart.notes.length.toLocaleString("ko-KR");
    ui.selectionLength.textContent = formatDuration(currentChart.meta.duration);
    ui.selectionHoldCount.textContent = String(currentChart.meta.holdNoteCount);
    ui.selectionInstruction.textContent =
      currentSourceType === "audio"
        ? "원곡에서 감지한 노트가 판정선에 닿을 때 해당 레인을 누르세요."
        : "탭 노트는 판정선에서 누르고, 긴 노트는 끝까지 유지한 뒤 놓으세요.";
    ui.gameTrackLabel.textContent = `${currentChart.meta.sourceTrack} · ${currentChart.meta.difficulty}`;
    setTransport("ready", "채보 준비 완료");
    setMessage(
      `${currentChart.meta.sourceTrack} · ${currentChart.notes.length} NOTES · ${currentChart.meta.holdNoteCount} HOLDS`,
      currentSourceType === "audio"
        ? "원곡에서 감지한 타격 지점이 판정선에 닿을 때 해당 레인을 입력하세요."
        : "긴 노트는 키를 누른 채 유지하고 꼬리가 판정선에 닿을 때 놓으세요.",
    );
    ui.sessionCode.textContent = "STANDBY";
    ui.sessionHeadline.textContent = "채보가 준비되었습니다";
    ui.sessionDetail.textContent = "D F J K 키 또는 화면 아래의 네 버튼을 사용하세요.";
  } catch (error) {
    handleError(error, "노트 데이터를 만들지 못했습니다");
  }
}

async function enterGame() {
  if (!currentChart || ui.enterGameButton.disabled || viewTransitionInProgress) return;
  viewTransitionInProgress = true;
  try {
    await judgementSpriteReady;
    await synth.playEnterCue();
    await playViewTransition(ui.selectionView, "view-fade-out", 260);
    ui.selectionView.hidden = true;
    ui.gameView.hidden = false;
    document.body.dataset.view = "game";
    history.replaceState(null, "", "#playfield");
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    game.resize();
    const fadeIn = playViewTransition(ui.gameView, "view-fade-in", 420);
    await startGame();
    await fadeIn;
  } finally {
    viewTransitionInProgress = false;
  }
}

async function returnToSelection() {
  if (viewTransitionInProgress) return;
  viewTransitionInProgress = true;
  game.stop(false);
  try {
    await playViewTransition(ui.gameView, "view-fade-out", 260);
    ui.gameView.hidden = true;
    ui.selectionView.hidden = false;
    document.body.dataset.view = "selection";
    history.replaceState(null, "", "#selectionView");
    setTransport("ready", "채보 준비 완료");
    setMessage(
      `${currentChart.meta.sourceTrack} · ${currentChart.notes.length} NOTES · ${currentChart.meta.holdNoteCount} HOLDS`,
      currentSourceType === "audio"
        ? "원곡에서 감지한 타격 지점이 판정선에 닿을 때 해당 레인을 입력하세요."
        : "긴 노트는 키를 누른 채 유지하고 꼬리가 판정선에 닿을 때 놓으세요.",
    );
    ui.sessionCode.textContent = "STANDBY";
    ui.sessionHeadline.textContent = "채보가 준비되었습니다";
    ui.sessionDetail.textContent = "D F J K 키 또는 화면 아래의 네 버튼을 사용하세요.";
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    ui.enterGameButton.focus({ preventScroll: true });
    viewTransitionInProgress = false;
    void playViewTransition(ui.selectionView, "view-fade-in", 420);
  } finally {
    viewTransitionInProgress = false;
  }
}

function playViewTransition(element, className, duration) {
  activeViewTransitions.get(element)?.();
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return Promise.resolve();
  element.classList.add(className);
  return new Promise((resolve) => {
    let finished = false;
    let fallbackTimer = null;
    const complete = () => {
      if (finished) return;
      finished = true;
      element.removeEventListener("animationend", handleAnimationEnd);
      if (fallbackTimer) window.clearTimeout(fallbackTimer);
      element.classList.remove(className);
      if (activeViewTransitions.get(element) === complete) activeViewTransitions.delete(element);
      resolve();
    };
    const handleAnimationEnd = (event) => {
      if (event.target === element) complete();
    };
    activeViewTransitions.set(element, complete);
    element.addEventListener("animationend", handleAnimationEnd);
    fallbackTimer = window.setTimeout(complete, duration + 80);
  });
}

async function startGame() {
  if (!currentChart || (currentSourceType === "midi" && !currentEvents.length)) return;
  try {
    logItems = [];
    renderLog();
    ui.stageMessage.hidden = true;
    ui.startButton.disabled = true;
    await game.start(currentEvents);
    ui.startButton.disabled = false;
    ui.startButton.firstChild.textContent = "다시 시작 ";
    ui.gameStage.focus({ preventScroll: true });
  } catch (error) {
    ui.startButton.disabled = false;
    handleError(error, "오디오를 시작하지 못했습니다");
  }
}

function handleGameState(state, detail) {
  if (state === "start-request") {
    if (!ui.selectionView.hidden) {
      enterGame();
    } else if (!ui.startButton.disabled) {
      startGame();
    }
    return;
  }
  if (state === "ready") return;
  if (state === "countdown") {
    setTransport("loading", "신호 동기화 중");
    ui.sessionCode.textContent = "COUNT-IN";
    ui.sessionHeadline.textContent = "첫 박자를 준비하세요";
    ui.sessionDetail.textContent = "오디오 시계와 3D 노트를 맞추고 있습니다.";
    return;
  }
  if (state === "playing") {
    setTransport("live", "LIVE · 플레이 중");
    ui.sessionCode.textContent = "LIVE";
    ui.sessionHeadline.textContent = "리듬이 흐르고 있습니다";
    ui.sessionDetail.textContent = "판정선에 노트가 닿을 때 해당 레인을 입력하세요.";
    return;
  }
  if (state === "finished") {
    const stats = detail.stats;
    setTransport("ready", "세션 완료");
    setMessage(
      `${stats.score.toLocaleString("ko-KR")} POINTS · ${stats.accuracy.toFixed(1)}%`,
      `최대 ${stats.maxCombo} 콤보 · MISS ${stats.miss} · 다시 시작할 수 있습니다.`,
    );
    ui.sessionCode.textContent = "COMPLETE";
    ui.sessionHeadline.textContent = `${stats.maxCombo} MAX COMBO`;
    ui.sessionDetail.textContent = `PERFECT ${stats.perfect} · GREAT ${stats.great} · GOOD ${stats.good} · MISS ${stats.miss}`;
  }
}

function updateScore(stats) {
  ui.scoreValue.textContent = stats.scoreLabel;
  ui.comboValue.textContent = stats.comboLabel;
  ui.accuracyValue.textContent = `${stats.accuracy.toFixed(1)}%`;
  if (stats.combo === 0) hideFeedbackMeta();
}

function updateCountdown(value) {
  ui.countdown.textContent = value ?? "";
  ui.countdown.dataset.visible = value == null ? "false" : "true";
  if (value != null) synth.playCountdownCue(value);
}

function updateHoldState(lane, holding) {
  const button = document.querySelector(`[data-lane="${lane}"]`);
  if (button) button.dataset.holding = String(holding);
}

function setJudgementContent(label, sprite = null) {
  const labelElement = document.createElement("span");
  labelElement.className = "judgement-label";
  if (sprite) {
    ui.judgement.dataset.sprite = sprite;
    labelElement.dataset.sprite = sprite;
    const accessibleLabel = document.createElement("span");
    accessibleLabel.className = "sr-only";
    accessibleLabel.textContent = label;
    const spriteSource = judgementSpriteSources?.[sprite];
    const spriteImage = spriteSource?.color.cloneNode() ?? document.createElement("img");
    spriteImage.className = "judgement-sprite-color";
    if (!spriteSource) {
      labelElement.dataset.atlas = "true";
      spriteImage.src = judgementSpriteSheetUrl;
    }
    spriteImage.alt = "";
    spriteImage.setAttribute("aria-hidden", "true");
    const whiteFlash = spriteSource?.white.cloneNode() ?? spriteImage.cloneNode();
    whiteFlash.className = "judgement-sprite-white-flash";
    labelElement.append(accessibleLabel, spriteImage, whiteFlash);
  } else {
    delete ui.judgement.dataset.sprite;
    labelElement.textContent = label;
  }
  ui.judgement.replaceChildren(labelElement);
}

function triggerMissFlash() {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const duration = reducedMotion ? 280 : 560;
  ui.missFlash.getAnimations().forEach((animation) => animation.cancel());
  ui.missFlash.dataset.visible = "true";
  ui.missFlash.dataset.flashDuration = String(duration);
  const flashCount = Number(ui.missFlash.dataset.flashCount || 0) + 1;
  ui.missFlash.dataset.flashCount = String(flashCount);
  const animation = ui.missFlash.animate(
    reducedMotion
      ? [
          { opacity: 0 },
          { opacity: 0.38, offset: 0.16 },
          { opacity: 0.24, offset: 0.58 },
          { opacity: 0 },
        ]
      : [
          { opacity: 0 },
          { opacity: 0.72, offset: 0.08 },
          { opacity: 0.58, offset: 0.34 },
          { opacity: 0.38, offset: 0.62 },
          { opacity: 0.18, offset: 0.82 },
          { opacity: 0 },
        ],
    {
      duration,
      easing: "linear",
      fill: "both",
    },
  );
  animation.finished
    .catch(() => {})
    .finally(() => {
      if (Number(ui.missFlash.dataset.flashCount) !== flashCount) return;
      ui.missFlash.dataset.visible = "false";
      animation.cancel();
    });
}

function hideFeedbackMeta() {
  ui.effectCombo.getAnimations().forEach((animation) => animation.cancel());
  ui.effectCombo.replaceChildren();
  ui.effectCombo.dataset.visible = "false";
}

function showFeedbackMeta(timing, combo) {
  const content = [];
  if (timing != null) {
    const timingElement = document.createElement("span");
    timingElement.className = "feedback-timing";
    timingElement.textContent = `${timing > 0 ? "+" : ""}${Math.round(timing)} ms`;
    content.push(timingElement);
  }

  if (combo > 1) {
    const chainElement = document.createElement("span");
    chainElement.className = "feedback-chain";
    chainElement.textContent = `${combo} chain`;
    content.push(chainElement);
  }

  ui.effectCombo.replaceChildren(...content);
  ui.effectCombo.dataset.visible = content.length ? "true" : "false";

  if (!content.length) return;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  ui.effectCombo.getAnimations().forEach((animation) => animation.cancel());
  ui.effectCombo.animate(
    reducedMotion
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [
          { transform: "translate(34px, -8px) skewX(-10deg)", filter: "blur(7px)", opacity: 0 },
          { transform: "translate(-7px, 0) skewX(-3deg)", filter: "blur(0)", opacity: 1, offset: 0.58 },
          { transform: "translate(0, 0) skewX(0)", filter: "blur(0)", opacity: 1 },
        ],
    { duration: reducedMotion ? 120 : 360, easing: "cubic-bezier(.12,.88,.2,1)" },
  );
}

function animateJudgement(name) {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const intensity = { PERFECT: 1, GREAT: 0.8, GOOD: 0.66, MISS: 0.76, HOLD: 0.58 }[name] ?? 0.7;
  const duration = name === "PERFECT" ? 560 : 470;
  const label = ui.judgement.querySelector(".judgement-label");
  const whiteFlash = ui.judgement.querySelector(".judgement-sprite-white-flash");

  ui.judgement.getAnimations().forEach((animation) => animation.cancel());
  label?.getAnimations().forEach((animation) => animation.cancel());
  if (whiteFlash) {
    whiteFlash.getAnimations().forEach((animation) => animation.cancel());
    whiteFlash.animate(
      reducedMotion
        ? [{ opacity: 1 }, { opacity: 0 }]
        : [
            { opacity: 1 },
            { opacity: 1, offset: 0.36 },
            { opacity: 0, offset: 0.7 },
            { opacity: 0 },
          ],
      { duration: reducedMotion ? 220 : duration, easing: "linear", fill: "both" },
    );
  }

  label?.animate(
    reducedMotion
      ? [
          { transform: "scale(0.94)", opacity: 0.9 },
          { transform: "scale(1)", opacity: 1 },
        ]
      : [
          {
            transform: "scale(0.52)",
            opacity: 0.9,
          },
          {
            transform: `scale(${1.14 + intensity * 0.06})`,
            opacity: 1,
            offset: 0.32,
          },
          {
            transform: "scale(0.95)",
            opacity: 1,
            offset: 0.66,
          },
          {
            transform: "scale(1)",
            opacity: 1,
          },
        ],
    { duration, easing: "cubic-bezier(.18,.86,.22,1)", fill: "both" },
  );
}

function showJudgement(name, timing, stats, lane, screenPosition, details = {}) {
  if (name === "EMPTY") return;
  window.clearTimeout(judgementTimer);

  if (name === "HOLD") {
    setJudgementContent("Hold");
    ui.judgement.dataset.kind = "hold";
    ui.judgement.dataset.visible = "true";
    animateJudgement(name);
    return;
  }

  const resultName = details.hold
    ? name === "MISS"
      ? "Hold break"
      : `Hold ${name === "PERFECT" ? "perfect!" : name.toLowerCase()}`
    : name === "PERFECT"
      ? "Perfect!"
      : `${name.charAt(0)}${name.slice(1).toLowerCase()}`;
  setJudgementContent(resultName, details.hold ? null : name.toLowerCase());
  ui.judgement.dataset.kind = name.toLowerCase();
  ui.judgement.dataset.visible = "true";
  if (name === "MISS") triggerMissFlash();
  if (stats.combo === 0 || name === "MISS") {
    hideFeedbackMeta();
  } else {
    showFeedbackMeta(timing, stats.combo);
  }
  animateJudgement(name);
  triggerHitConfirmation(name, lane, screenPosition);
  judgementTimer = window.setTimeout(() => {
    ui.judgement.dataset.visible = "false";
  }, name === "PERFECT" ? 560 : 430);
  addLogItem(name, timing, details);
}

function triggerHitConfirmation(name, lane, screenPosition) {
  if (!["PERFECT", "GREAT", "GOOD"].includes(name)) return;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const lanePositions = [17.5, 39.2, 60.8, 82.5];
  const marker = document.createElement("span");
  marker.className = "hit-confirmation";
  marker.dataset.kind = name.toLowerCase();
  marker.style.left = screenPosition ? `${screenPosition.x}px` : `${lanePositions[lane] ?? 50}%`;
  marker.style.top = screenPosition ? `${screenPosition.y}px` : "calc(100% - 39px)";
  marker.dataset.positionSource = screenPosition ? "projected-3d" : "fallback";
  marker.setAttribute("aria-hidden", "true");
  marker.innerHTML = "<i></i>";
  ui.gameStage.append(marker);
  window.setTimeout(() => marker.remove(), reducedMotion ? 220 : 620);

}

function addLogItem(name, timing, details = {}) {
  const now = new Date();
  const resultName = details.hold
    ? name === "MISS"
      ? `HOLD BREAK${details.reason ? ` · ${details.reason}` : ""}`
      : `HOLD ${name}`
    : name;
  logItems.unshift({
    time: `${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`,
    label: timing == null ? resultName : `${resultName} · ${timing > 0 ? "+" : ""}${Math.round(timing)}ms`,
    kind: name.toLowerCase(),
  });
  logItems = logItems.slice(0, 6);
  renderLog();
}

function renderLog() {
  ui.eventLog.replaceChildren();
  if (!logItems.length) {
    const item = document.createElement("li");
    item.innerHTML = "<time>—</time><span>첫 판정을 기다립니다</span>";
    ui.eventLog.append(item);
    return;
  }
  for (const entry of logItems) {
    const item = document.createElement("li");
    item.dataset.kind = entry.kind;
    const time = document.createElement("time");
    const label = document.createElement("span");
    time.textContent = entry.time;
    label.textContent = entry.label;
    item.append(time, label);
    ui.eventLog.append(item);
  }
}

function exportChart() {
  if (!currentChart) return;
  const blob = new Blob([chartToJson(currentChart)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${currentFileName.replace(/\.(mid|midi|mp3)$/i, "")}.${currentChart.meta.difficulty.toLowerCase()}.chart.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function handleError(error, title) {
  console.error(error);
  setTransport("error", "오류 · 확인 필요");
  setMessage(title, error.message || "알 수 없는 오류가 발생했습니다.");
  ui.sessionCode.textContent = "ERROR";
  ui.sessionHeadline.textContent = title;
  ui.sessionDetail.textContent = error.message || "다른 MIDI 또는 MP3 파일로 다시 시도해 주세요.";
}

ui.fileButton.addEventListener("click", () => ui.midiFileInput.click());
ui.midiFileInput.addEventListener("change", () => {
  const [file] = ui.midiFileInput.files;
  if (file) loadSelectedFile(file);
});
ui.fileDropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  ui.fileDropZone.dataset.dragging = "true";
});
ui.fileDropZone.addEventListener("dragleave", () => {
  ui.fileDropZone.dataset.dragging = "false";
});
ui.fileDropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  ui.fileDropZone.dataset.dragging = "false";
  const [file] = event.dataTransfer.files;
  if (file) loadSelectedFile(file);
});
ui.generateButton.addEventListener("click", buildChart);
ui.trackSelect.addEventListener("change", buildChart);
ui.difficultySelect.addEventListener("change", buildChart);
ui.selectionDifficulty.addEventListener("click", (event) => {
  const button = event.target.closest("[data-difficulty]");
  if (!button || button.dataset.difficulty === ui.difficultySelect.value) return;
  ui.difficultySelect.value = button.dataset.difficulty;
  syncDifficultyPicker();
  buildChart();
});
ui.exportButton.addEventListener("click", exportChart);
ui.startButton.addEventListener("click", startGame);
ui.enterGameButton.addEventListener("click", enterGame);
ui.backButton.addEventListener("click", returnToSelection);
ui.brandHome.addEventListener("click", (event) => {
  event.preventDefault();
  if (!ui.gameView.hidden && currentChart) returnToSelection();
});

window.addEventListener("keydown", (event) => {
  if (event.code === "Escape" && !event.repeat && !ui.gameView.hidden && currentChart) {
    event.preventDefault();
    returnToSelection();
  }
});

document.querySelectorAll("[data-lane]").forEach((button) => {
  const lane = Number(button.dataset.lane);
  const hit = (event) => {
    event.preventDefault();
    button.dataset.pressed = "true";
    if (button.setPointerCapture) button.setPointerCapture(event.pointerId);
    game.hitLane(lane);
  };
  const release = (event) => {
    event.preventDefault();
    button.dataset.pressed = "false";
    game.releaseLane(lane);
  };
  button.addEventListener("pointerdown", hit);
  button.addEventListener("pointerup", release);
  button.addEventListener("pointercancel", release);
});

document.body.dataset.view = "selection";
loadDefaultTrack();
