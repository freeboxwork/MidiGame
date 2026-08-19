const AUDIO_DIFFICULTY_PRESETS = {
  calm: { label: "CALM", subdivisions: 1, maxPerMeasure: 3, quantile: 0.58, maxChordNotes: 1 },
  standard: { label: "STANDARD", subdivisions: 2, maxPerMeasure: 6, quantile: 0.46, maxChordNotes: 2 },
  expert: { label: "EXPERT", subdivisions: 4, maxPerMeasure: 12, quantile: 0.34, maxChordNotes: 2 },
};

const DEFAULT_KEYS = ["D", "F", "J", "K"];
const ANALYSIS_HOP_SIZE = 512;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function quantile(values, amount) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * amount))];
}

function estimateTempo(onsetEnvelope, framesPerSecond) {
  const minimumLag = Math.round((framesPerSecond * 60) / 190);
  const maximumLag = Math.round((framesPerSecond * 60) / 70);
  const correlations = new Float32Array(maximumLag + 1);
  let bestLag = Math.round((framesPerSecond * 60) / 120);
  let bestScore = -Infinity;

  for (let lag = minimumLag; lag <= maximumLag; lag += 1) {
    let correlation = 0;
    let energy = 0;
    for (let index = lag; index < onsetEnvelope.length; index += 1) {
      const current = onsetEnvelope[index];
      const delayed = onsetEnvelope[index - lag];
      correlation += current * delayed;
      energy += current * current + delayed * delayed;
    }
    correlations[lag] = energy > 0 ? (correlation * 2) / energy : 0;
    if (correlations[lag] > bestScore) {
      bestScore = correlations[lag];
      bestLag = lag;
    }
  }

  const previous = correlations[Math.max(minimumLag, bestLag - 1)];
  const current = correlations[bestLag];
  const next = correlations[Math.min(maximumLag, bestLag + 1)];
  const denominator = previous - 2 * current + next;
  const adjustment = Math.abs(denominator) > 1e-7
    ? clamp(0.5 * (previous - next) / denominator, -0.5, 0.5)
    : 0;
  let beatPeriodFrames = bestLag + adjustment;
  let bpm = (framesPerSecond * 60) / beatPeriodFrames;

  if (bpm > 155) {
    bpm /= 2;
    beatPeriodFrames *= 2;
  } else if (bpm < 78) {
    bpm *= 2;
    beatPeriodFrames /= 2;
  }

  return {
    bpm: Number(bpm.toFixed(1)),
    beatPeriodFrames,
  };
}

function analyzeAudio(audioBuffer) {
  const sampleRate = audioBuffer.sampleRate;
  const channels = Array.from(
    { length: Math.min(2, audioBuffer.numberOfChannels) },
    (_, channel) => audioBuffer.getChannelData(channel),
  );
  const sampleCount = audioBuffer.length ?? channels[0]?.length ?? 0;
  const frameCount = Math.ceil(sampleCount / ANALYSIS_HOP_SIZE);
  const lowEnergy = new Float32Array(frameCount);
  const midEnergy = new Float32Array(frameCount);
  const highEnergy = new Float32Array(frameCount);
  const lowAlpha = 1 - Math.exp((-Math.PI * 2 * 180) / sampleRate);
  const broadAlpha = 1 - Math.exp((-Math.PI * 2 * 2200) / sampleRate);
  let lowState = 0;
  let broadState = 0;

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * ANALYSIS_HOP_SIZE;
    const end = Math.min(sampleCount, start + ANALYSIS_HOP_SIZE);
    let lowSum = 0;
    let midSum = 0;
    let highSum = 0;

    for (let index = start; index < end; index += 1) {
      let sample = 0;
      for (const channel of channels) sample += channel[index] || 0;
      sample /= Math.max(1, channels.length);
      lowState += lowAlpha * (sample - lowState);
      broadState += broadAlpha * (sample - broadState);
      const low = lowState;
      const mid = broadState - lowState;
      const high = sample - broadState;
      lowSum += low * low;
      midSum += mid * mid;
      highSum += high * high;
    }

    const frameLength = Math.max(1, end - start);
    lowEnergy[frame] = Math.sqrt(lowSum / frameLength);
    midEnergy[frame] = Math.sqrt(midSum / frameLength);
    highEnergy[frame] = Math.sqrt(highSum / frameLength);
  }

  const onsetEnvelope = new Float32Array(frameCount);
  const rawFlux = new Float32Array(frameCount);
  const bandFlux = Array.from({ length: frameCount }, () => [0, 0, 0]);

  for (let frame = 1; frame < frameCount; frame += 1) {
    const low = Math.max(0, lowEnergy[frame] - lowEnergy[frame - 1] * 0.94);
    const mid = Math.max(0, midEnergy[frame] - midEnergy[frame - 1] * 0.94);
    const high = Math.max(0, highEnergy[frame] - highEnergy[frame - 1] * 0.94);
    bandFlux[frame] = [low, mid, high];
    rawFlux[frame] = low * 1.45 + mid + high * 0.38;
  }

  const fluxReference = Math.max(1e-7, quantile([...rawFlux].filter(Boolean), 0.72));
  let rollingSum = 0;
  const rollingWindow = Math.max(4, Math.round((sampleRate / ANALYSIS_HOP_SIZE) * 0.28));

  for (let frame = 1; frame < frameCount; frame += 1) {
    const flux = rawFlux[frame];
    const previousMean = rollingSum / Math.max(1, Math.min(frame, rollingWindow));
    const relativeRise = flux / (previousMean + 1e-7);
    const absoluteWeight = Math.sqrt(clamp(flux / fluxReference, 0, 2.5));
    onsetEnvelope[frame] = relativeRise * absoluteWeight;
    rollingSum += flux;
    if (frame >= rollingWindow) {
      rollingSum -= rawFlux[frame - rollingWindow];
    }
  }

  return {
    onsetEnvelope,
    bandFlux,
    framesPerSecond: sampleRate / ANALYSIS_HOP_SIZE,
  };
}

function findGridOffset(onsetEnvelope, stepFrames) {
  const phaseCount = Math.max(1, Math.round(stepFrames));
  let bestOffset = 0;
  let bestScore = -Infinity;

  for (let offset = 0; offset < phaseCount; offset += 1) {
    let score = 0;
    for (let frame = offset; frame < onsetEnvelope.length; frame += stepFrames) {
      const center = Math.round(frame);
      score += Math.max(
        onsetEnvelope[center - 1] || 0,
        onsetEnvelope[center] || 0,
        onsetEnvelope[center + 1] || 0,
      );
    }
    if (score > bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }

  return bestOffset;
}

function chooseEvents(analysis, duration, preset, tempo) {
  const candidates = [];
  const { onsetEnvelope, bandFlux, framesPerSecond } = analysis;
  const stepFrames = tempo.beatPeriodFrames / preset.subdivisions;
  const gridOffset = findGridOffset(onsetEnvelope, stepFrames);
  const snapTolerance = Math.max(2, stepFrames * 0.2);

  for (let frame = 2; frame < onsetEnvelope.length - 2; frame += 1) {
    const score = onsetEnvelope[frame];
    if (
      score <= onsetEnvelope[frame - 1] ||
      score < onsetEnvelope[frame + 1] ||
      score < 1.02
    ) {
      continue;
    }
    const gridIndex = Math.round((frame - gridOffset) / stepFrames);
    const snappedFrame = gridOffset + gridIndex * stepFrames;
    if (Math.abs(frame - snappedFrame) > snapTolerance) continue;
    const time = (frame + 0.5) / framesPerSecond;
    if (time < 0.15 || time > duration - 0.2) continue;
    candidates.push({
      time,
      score,
      bands: bandFlux[frame],
      gridIndex,
      snapError: Math.abs(frame - snappedFrame) / framesPerSecond,
    });
  }

  const strongestByGrid = new Map();
  for (const candidate of candidates) {
    const previous = strongestByGrid.get(candidate.gridIndex);
    if (!previous || candidate.score > previous.score) {
      strongestByGrid.set(candidate.gridIndex, candidate);
    }
  }
  const gridCandidates = [...strongestByGrid.values()];

  const threshold = quantile(
    gridCandidates.map((candidate) => candidate.score),
    preset.quantile,
  );
  const measures = new Map();
  for (const candidate of gridCandidates) {
    if (candidate.score < threshold) continue;
    const measure = Math.floor(candidate.gridIndex / (preset.subdivisions * 4));
    if (!measures.has(measure)) measures.set(measure, []);
    measures.get(measure).push(candidate);
  }
  const selected = [...measures.values()].flatMap((events) =>
    events.sort((a, b) => b.score - a.score).slice(0, preset.maxPerMeasure),
  );

  return {
    events: selected.sort((a, b) => a.time - b.time),
    candidateCount: gridCandidates.length,
    threshold,
    gridOffsetSeconds: gridOffset / framesPerSecond,
    meanSnapError:
      selected.reduce((sum, event) => sum + event.snapError, 0) / Math.max(1, selected.length),
  };
}

function lanesForEvent(event, eventIndex, preset, threshold) {
  const rankedBands = event.bands
    .map((strength, band) => ({ strength, band }))
    .sort((a, b) => b.strength - a.strength);
  const primary = rankedBands[0];
  const lanes = [
    primary.band === 0
      ? 0
      : primary.band === 1
        ? 3
        : event.gridIndex % 2 === 0
          ? 2
          : 1,
  ];
  const secondary = rankedBands[1];

  if (
    preset.maxChordNotes > 1 &&
    secondary.strength > primary.strength * 0.7 &&
    event.score > threshold * 1.22
  ) {
    const secondaryLane = secondary.band === 0 ? 0 : secondary.band === 1 ? 3 : eventIndex % 2 ? 1 : 2;
    if (!lanes.includes(secondaryLane)) lanes.push(secondaryLane);
  }

  return lanes;
}

export function generateAudioChart(audioBuffer, options = {}) {
  if (!audioBuffer || !audioBuffer.length || !audioBuffer.sampleRate) {
    throw new Error("분석할 오디오 데이터가 없습니다.");
  }

  const difficultyName = options.difficulty ?? "standard";
  const preset = AUDIO_DIFFICULTY_PRESETS[difficultyName] || AUDIO_DIFFICULTY_PRESETS.standard;
  const duration = Number(audioBuffer.duration || audioBuffer.length / audioBuffer.sampleRate);
  const analysis = analyzeAudio(audioBuffer);
  const tempo = estimateTempo(analysis.onsetEnvelope, analysis.framesPerSecond);
  const selection = chooseEvents(analysis, duration, preset, tempo);
  if (selection.events.length < 12) {
    throw new Error("리듬 타격 지점을 충분히 찾지 못했습니다. 다른 MP3로 시도해 주세요.");
  }

  const scores = selection.events.map((event) => event.score);
  const scoreFloor = quantile(scores, 0.08);
  const scoreCeiling = Math.max(scoreFloor + 0.001, quantile(scores, 0.94));
  const notes = [];

  selection.events.forEach((event, eventIndex) => {
    const velocity = clamp((event.score - scoreFloor) / (scoreCeiling - scoreFloor), 0.35, 1);
    const lanes = lanesForEvent(event, eventIndex, preset, selection.threshold);
    for (const lane of lanes) {
      const time = Number(event.time.toFixed(4));
      const noteDuration = 0.09;
      notes.push({
        id: `n${String(notes.length + 1).padStart(4, "0")}`,
        time,
        duration: noteDuration,
        endTime: Number((time + noteDuration).toFixed(4)),
        type: "tap",
        lane,
        pitch: [36, 52, 68, 84][lane],
        velocity: Number(velocity.toFixed(3)),
      });
    }
  });

  notes.sort((a, b) => a.time - b.time || a.lane - b.lane);
  notes.forEach((note, index) => {
    note.id = `n${String(index + 1).padStart(4, "0")}`;
  });
  const sourceFile = options.sourceFile || "audio.mp3";

  return {
    version: 2,
    meta: {
      title: sourceFile.replace(/\.mp3$/i, ""),
      sourceFile,
      sourceTrack: "AUTO RHYTHM",
      sourceTrackIndex: null,
      sourceNoteCount: selection.candidateCount,
      bpm: tempo.bpm,
      duration: Number(duration.toFixed(3)),
      sourceDuration: Number(duration.toFixed(3)),
      audioStart: 0,
      difficulty: preset.label,
      laneCount: 4,
      keys: DEFAULT_KEYS,
      holdThreshold: null,
      holdNoteCount: 0,
      analysisType: "audio-onset",
      beatOffset: Number(selection.gridOffsetSeconds.toFixed(4)),
      meanSnapErrorMs: Number((selection.meanSnapError * 1000).toFixed(1)),
    },
    notes,
  };
}

export { AUDIO_DIFFICULTY_PRESETS };
