const DIFFICULTY_PRESETS = {
  calm: { minGap: 0.2, maxChordNotes: 1, label: "CALM" },
  standard: { minGap: 0.105, maxChordNotes: 2, label: "STANDARD" },
  expert: { minGap: 0.045, maxChordNotes: 4, label: "EXPERT" },
};

const DEFAULT_KEYS = ["D", "F", "J", "K"];
const CHORD_WINDOW_SECONDS = 0.018;
const HOLD_THRESHOLD_SECONDS = 0.5;

function safeNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function nameForTrack(track, index) {
  return track.name?.trim() || `Track ${String(index + 1).padStart(2, "0")}`;
}

export function listPlayableTracks(midi) {
  return midi.tracks
    .map((track, index) => ({
      index,
      name: nameForTrack(track, index),
      noteCount: track.notes.length,
      channel: track.channel,
      percussion: Boolean(track.instrument?.percussion || track.channel === 9),
    }))
    .filter((track) => track.noteCount > 0);
}

export function pickRecommendedTrack(midi) {
  const tracks = listPlayableTracks(midi);
  if (!tracks.length) {
    throw new Error("연주 가능한 노트가 들어 있는 트랙을 찾지 못했습니다.");
  }

  const namedLead = tracks.find((track) => /lead|melody|vocal|sax|solo/i.test(track.name));
  if (namedLead) return namedLead.index;

  const melodic = tracks
    .filter((track) => !track.percussion)
    .sort((a, b) => {
      const aFit = Math.abs(a.noteCount - 240);
      const bFit = Math.abs(b.noteCount - 240);
      return aFit - bFit;
    });

  return (melodic[0] || tracks[0]).index;
}

function groupSimultaneousNotes(notes) {
  const groups = [];
  for (const note of notes) {
    const last = groups.at(-1);
    if (last && Math.abs(note.time - last.time) <= CHORD_WINDOW_SECONDS) {
      last.notes.push(note);
    } else {
      groups.push({ time: note.time, notes: [note] });
    }
  }
  return groups;
}

function closestFreeLane(preferred, used, laneCount) {
  if (!used.has(preferred)) return preferred;
  for (let distance = 1; distance < laneCount; distance += 1) {
    const left = preferred - distance;
    const right = preferred + distance;
    if (left >= 0 && !used.has(left)) return left;
    if (right < laneCount && !used.has(right)) return right;
  }
  return preferred;
}

function laneForPitch(pitch, minPitch, maxPitch, laneCount) {
  if (maxPitch === minPitch) return Math.floor(laneCount / 2);
  const normalized = (pitch - minPitch) / (maxPitch - minPitch);
  return Math.min(laneCount - 1, Math.max(0, Math.floor(normalized * laneCount)));
}

export function generateChart(midi, options = {}) {
  const laneCount = options.laneCount ?? 4;
  const difficultyName = options.difficulty ?? "standard";
  const preset = DIFFICULTY_PRESETS[difficultyName] || DIFFICULTY_PRESETS.standard;
  const trackIndex = Number.isInteger(options.trackIndex)
    ? options.trackIndex
    : pickRecommendedTrack(midi);
  const track = midi.tracks[trackIndex];

  if (!track || !track.notes.length) {
    throw new Error("선택한 트랙에는 변환할 MIDI 노트가 없습니다.");
  }

  const sortedNotes = [...track.notes].sort((a, b) => a.time - b.time || a.midi - b.midi);
  const pitches = sortedNotes.map((note) => note.midi);
  const minPitch = Math.min(...pitches);
  const maxPitch = Math.max(...pitches);
  const groups = groupSimultaneousNotes(sortedNotes);
  const chartNotes = [];
  let lastAcceptedTime = -Infinity;

  for (const group of groups) {
    if (group.time - lastAcceptedTime < preset.minGap) continue;

    const chosen = [...group.notes]
      .sort((a, b) => b.velocity - a.velocity)
      .slice(0, preset.maxChordNotes)
      .sort((a, b) => a.midi - b.midi);
    const usedLanes = new Set();

    for (const sourceNote of chosen) {
      const preferredLane = laneForPitch(sourceNote.midi, minPitch, maxPitch, laneCount);
      const lane = closestFreeLane(preferredLane, usedLanes, laneCount);
      const duration = Number(Math.max(0.05, sourceNote.duration).toFixed(4));
      usedLanes.add(lane);
      chartNotes.push({
        id: `n${String(chartNotes.length + 1).padStart(4, "0")}`,
        time: Number(sourceNote.time.toFixed(4)),
        duration,
        type: duration >= HOLD_THRESHOLD_SECONDS ? "hold" : "tap",
        lane,
        pitch: sourceNote.midi,
        velocity: Number(safeNumber(sourceNote.velocity, 0.75).toFixed(3)),
      });
    }

    lastAcceptedTime = group.time;
  }

  const firstPlayableTime = chartNotes[0]?.time ?? 0;
  const audioStart = options.keepFullIntro ? 0 : Math.max(0, firstPlayableTime - 2);
  for (const note of chartNotes) {
    note.time = Number((note.time - audioStart).toFixed(4));
    note.endTime = Number((note.time + note.duration).toFixed(4));
  }

  const bpm = midi.header.tempos?.[0]?.bpm || 120;
  const sourceName = nameForTrack(track, trackIndex);
  const title = options.title || options.sourceFile?.replace(/\.(mid|midi)$/i, "") || "Untitled MIDI";

  return {
    version: 2,
    meta: {
      title,
      sourceFile: options.sourceFile || null,
      sourceTrack: sourceName,
      sourceTrackIndex: trackIndex,
      sourceNoteCount: track.notes.length,
      bpm: Number(bpm.toFixed(2)),
      duration: Number(Math.max(0, safeNumber(midi.duration) - audioStart).toFixed(3)),
      sourceDuration: Number(safeNumber(midi.duration).toFixed(3)),
      audioStart: Number(audioStart.toFixed(3)),
      difficulty: preset.label,
      laneCount,
      keys: DEFAULT_KEYS.slice(0, laneCount),
      holdThreshold: HOLD_THRESHOLD_SECONDS,
      holdNoteCount: chartNotes.filter((note) => note.type === "hold").length,
    },
    notes: chartNotes,
  };
}

export function extractMidiEvents(midi, audioStart = 0) {
  return midi.tracks
    .flatMap((track, trackIndex) =>
      track.notes
        .filter((note) => note.time + note.duration >= audioStart)
        .map((note) => ({
        time: Math.max(0, note.time - audioStart),
        duration: note.duration,
        midi: note.midi,
        velocity: note.velocity,
        channel: track.channel,
        percussion: Boolean(track.instrument?.percussion || track.channel === 9),
        program: track.instrument?.number ?? 0,
        trackIndex,
        trackName: nameForTrack(track, trackIndex),
        })),
    )
    .sort((a, b) => a.time - b.time || a.midi - b.midi);
}

export function chartToJson(chart) {
  return `${JSON.stringify(chart, null, 2)}\n`;
}

export { DIFFICULTY_PRESETS, HOLD_THRESHOLD_SECONDS };
