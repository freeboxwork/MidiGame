from __future__ import annotations

import json
import random
import struct
from dataclasses import dataclass
from pathlib import Path


PPQ = 480
BPM = 132
BEATS_PER_BAR = 4
BAR_TICKS = PPQ * BEATS_PER_BAR
SWING = 2 / 3
OUTPUT_PATH = Path(__file__).resolve().parents[1] / "output" / "midnight_circuit_jazz.mid"


def variable_length(value: int) -> bytes:
    if value < 0:
        raise ValueError("MIDI delta times cannot be negative")
    buffer = value & 0x7F
    encoded = bytearray([buffer])
    while value >> 7:
        value >>= 7
        buffer = (value & 0x7F) | 0x80
        encoded.insert(0, buffer)
    return bytes(encoded)


def meta_event(meta_type: int, payload: bytes) -> bytes:
    return bytes([0xFF, meta_type]) + variable_length(len(payload)) + payload


def note_number(name: str) -> int:
    semitones = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
    letter = name[0].upper()
    octave = int(name[-1])
    accidental = name[1:-1]
    pitch = semitones[letter]
    if accidental == "#":
        pitch += 1
    elif accidental == "b":
        pitch -= 1
    elif accidental:
        raise ValueError(f"Unsupported note name: {name}")
    return (octave + 1) * 12 + pitch


@dataclass(order=True)
class Event:
    tick: int
    priority: int
    order: int
    data: bytes


class MidiTrack:
    def __init__(self, name: str) -> None:
        self.name = name
        self.events: list[Event] = []
        self._order = 0
        self.add(0, 0, meta_event(0x03, name.encode("utf-8")))

    def add(self, tick: int, priority: int, data: bytes) -> None:
        self.events.append(Event(max(0, int(tick)), priority, self._order, data))
        self._order += 1

    def add_meta(self, tick: int, meta_type: int, payload: bytes, priority: int = 0) -> None:
        self.add(tick, priority, meta_event(meta_type, payload))

    def program_change(self, channel: int, program: int) -> None:
        self.add(0, 1, bytes([0xC0 | channel, program]))

    def control_change(self, channel: int, controller: int, value: int, tick: int = 0) -> None:
        self.add(tick, 1, bytes([0xB0 | channel, controller, value]))

    def note(self, channel: int, pitch: int, start: int, duration: int, velocity: int) -> None:
        pitch = max(0, min(127, pitch))
        velocity = max(1, min(127, velocity))
        self.add(start, 2, bytes([0x90 | channel, pitch, velocity]))
        self.add(start + max(1, duration), 0, bytes([0x80 | channel, pitch, 0]))

    def build(self, end_tick: int) -> bytes:
        self.add(end_tick, 9, meta_event(0x2F, b""))
        payload = bytearray()
        previous_tick = 0
        for event in sorted(self.events):
            payload.extend(variable_length(event.tick - previous_tick))
            payload.extend(event.data)
            previous_tick = event.tick
        return b"MTrk" + struct.pack(">I", len(payload)) + bytes(payload)


ChordBar = list[tuple[str, int]]


INTRO: list[ChordBar] = [
    [("Bbmaj7", 4)],
    [("Bbmaj7", 4)],
    [("G7", 4)],
    [("Cm7", 2), ("F7", 2)],
]

A1: list[ChordBar] = [
    [("Bbmaj7", 4)],
    [("G7", 4)],
    [("Cm7", 4)],
    [("F7", 4)],
    [("Dm7", 2), ("G7", 2)],
    [("Cm7", 2), ("F7", 2)],
    [("Bbmaj7", 2), ("G7", 2)],
    [("Cm7", 2), ("F7", 2)],
]

A2: list[ChordBar] = [
    [("Bbmaj7", 4)],
    [("G7", 4)],
    [("Cm7", 4)],
    [("F7", 4)],
    [("Dm7", 2), ("G7", 2)],
    [("Cm7", 2), ("F7", 2)],
    [("Bb6", 2), ("F7/A", 2)],
    [("Bb6", 2), ("F7", 2)],
]

BRIDGE: list[ChordBar] = [
    [("D7", 4)],
    [("D7", 4)],
    [("G7", 4)],
    [("G7", 4)],
    [("C7", 4)],
    [("C7", 4)],
    [("F7", 4)],
    [("F7", 4)],
]

A3: list[ChordBar] = [
    [("Bbmaj7", 4)],
    [("G7", 4)],
    [("Cm7", 4)],
    [("F7", 4)],
    [("Dm7", 2), ("G7", 2)],
    [("Cm7", 2), ("F7", 2)],
    [("Bbmaj7", 2), ("G7", 2)],
    [("Cm7", 2), ("Bb6", 2)],
]

FORM = INTRO + A1 + A2 + BRIDGE + A3
TOTAL_BARS = len(FORM)
TOTAL_TICKS = TOTAL_BARS * BAR_TICKS


PIANO_VOICINGS: dict[str, list[int]] = {
    "Bbmaj7": [note_number(n) for n in ("D4", "F4", "A4", "C5")],
    "Bb6": [note_number(n) for n in ("D4", "F4", "G4", "C5")],
    "G7": [note_number(n) for n in ("F3", "B3", "Eb4", "A4")],
    "Cm7": [note_number(n) for n in ("Eb4", "G4", "Bb4", "D5")],
    "F7": [note_number(n) for n in ("Eb4", "A4", "D5", "G5")],
    "F7/A": [note_number(n) for n in ("Eb4", "A4", "C5", "G5")],
    "Dm7": [note_number(n) for n in ("F4", "A4", "C5", "E5")],
    "D7": [note_number(n) for n in ("F#4", "C5", "E5", "A5")],
    "C7": [note_number(n) for n in ("E4", "Bb4", "D5", "A5")],
}

BASS_ROOTS = {
    "Bbmaj7": note_number("Bb2"),
    "Bb6": note_number("Bb2"),
    "G7": note_number("G2"),
    "Cm7": note_number("C3"),
    "F7": note_number("F2"),
    "F7/A": note_number("A2"),
    "Dm7": note_number("D2"),
    "D7": note_number("D2"),
    "C7": note_number("C2"),
}

BASS_TONES = {
    "Bbmaj7": [note_number(n) for n in ("Bb2", "D3", "F3", "A3")],
    "Bb6": [note_number(n) for n in ("Bb2", "D3", "F3", "G3")],
    "G7": [note_number(n) for n in ("G2", "B2", "D3", "F3")],
    "Cm7": [note_number(n) for n in ("C3", "Eb3", "G3", "Bb3")],
    "F7": [note_number(n) for n in ("F2", "A2", "C3", "Eb3")],
    "F7/A": [note_number(n) for n in ("A2", "C3", "Eb3", "F3")],
    "Dm7": [note_number(n) for n in ("D2", "F2", "A2", "C3")],
    "D7": [note_number(n) for n in ("D2", "F#2", "A2", "C3")],
    "C7": [note_number(n) for n in ("C2", "E2", "G2", "Bb2")],
}


def beats(value: float) -> int:
    return round(value * PPQ)


def chord_at(bar: ChordBar, beat: int) -> tuple[str, int, int]:
    cursor = 0
    for chord, duration in bar:
        if cursor <= beat < cursor + duration:
            return chord, cursor, duration
        cursor += duration
    raise ValueError(f"Beat {beat} is outside bar {bar}")


def next_bar_root(bar_index: int) -> int:
    next_index = min(bar_index + 1, TOTAL_BARS - 1)
    return BASS_ROOTS[FORM[next_index][0][0]]


def nearest_pitch_class(pitch: int, reference: int) -> int:
    options = [pitch + 12 * shift for shift in range(-2, 3)]
    return min(options, key=lambda candidate: abs(candidate - reference))


def add_conductor(track: MidiTrack) -> None:
    microseconds = round(60_000_000 / BPM)
    track.add_meta(0, 0x51, microseconds.to_bytes(3, "big"))
    track.add_meta(0, 0x58, bytes([4, 2, 24, 8]))
    track.add_meta(0, 0x59, bytes([0xFE, 0]))  # B-flat major
    track.add_meta(0, 0x01, b"Original jazz composition: Midnight Circuit")
    for bar, label in ((0, "Intro"), (4, "A1"), (12, "A2"), (20, "Bridge"), (28, "A3"), (36, "End")):
        track.add_meta(bar * BAR_TICKS, 0x06, label.encode("ascii"))


def add_piano(track: MidiTrack, rng: random.Random) -> None:
    channel = 0
    track.program_change(channel, 0)
    track.control_change(channel, 7, 88)
    track.control_change(channel, 10, 54)
    track.control_change(channel, 91, 28)
    patterns = [
        [(0.0, 0.72), (1 + SWING, 0.42), (3.0, 0.76)],
        [(SWING, 0.38), (2.0, 0.72), (3 + SWING, 0.25)],
        [(0.0, 1.10), (2 + SWING, 0.64)],
        [(1.0, 0.48), (1 + SWING, 0.30), (3.0, 0.82)],
    ]
    for bar_index, bar in enumerate(FORM):
        bar_tick = bar_index * BAR_TICKS
        segment_start = 0
        for segment_index, (chord, duration_beats) in enumerate(bar):
            if bar_index < 2:
                local_pattern = [(0.0, 1.65), (2 + SWING, 0.58)]
            elif duration_beats == 2:
                local_pattern = [(0.0, 0.68), (1 + SWING, 0.25)]
            else:
                local_pattern = patterns[(bar_index + segment_index) % len(patterns)]
            for onset, length in local_pattern:
                if onset >= duration_beats:
                    continue
                human = rng.randint(-7, 9)
                start = bar_tick + beats(segment_start + onset) + human
                max_length = duration_beats - onset - 0.04
                duration = beats(max(0.18, min(length, max_length)))
                velocity = rng.randint(54, 72)
                voicing = PIANO_VOICINGS[chord]
                for voice, pitch in enumerate(voicing):
                    track.note(channel, pitch, start + voice * rng.randint(3, 7), duration, velocity + voice)
            segment_start += duration_beats


def add_bass(track: MidiTrack, rng: random.Random) -> None:
    channel = 1
    track.program_change(channel, 32)
    track.control_change(channel, 7, 98)
    track.control_change(channel, 10, 64)
    track.control_change(channel, 91, 12)
    for bar_index, bar in enumerate(FORM):
        pitches: list[int] = []
        for beat_index in range(4):
            chord, segment_start, segment_duration = chord_at(bar, beat_index)
            tones = BASS_TONES[chord]
            relative = beat_index - segment_start
            if relative == 0:
                pitch = BASS_ROOTS[chord]
            elif relative == 1:
                pitch = tones[2 if (bar_index + beat_index) % 2 == 0 else 1]
            elif relative == 2:
                pitch = tones[3]
            else:
                pitch = tones[1 if bar_index % 2 else 2]
            pitches.append(pitch)

        target = next_bar_root(bar_index)
        target = nearest_pitch_class(target, pitches[-2])
        pitches[-1] = target - 1 if target >= pitches[-2] else target + 1

        for beat_index, pitch in enumerate(pitches):
            human = rng.randint(-4, 5)
            start = bar_index * BAR_TICKS + beat_index * PPQ + human
            velocity = 82 + (4 if beat_index in (0, 2) else 0) + rng.randint(-3, 3)
            track.note(channel, pitch, start, beats(0.84), velocity)


PhraseEvent = tuple[float, str, float, int]


INTRO_MELODY: list[list[PhraseEvent]] = [
    [],
    [],
    [(2.0, "D5", 0.56, 70), (2 + SWING, "F5", 0.25, 72), (3.0, "Ab5", 0.56, 78), (3 + SWING, "G5", 0.24, 70)],
    [(0.0, "G5", 0.56, 75), (1.0, "Eb5", 0.56, 71), (2.0, "C5", 0.56, 73), (2 + SWING, "A4", 0.24, 68), (3.0, "C5", 0.54, 72), (3 + SWING, "D5", 0.24, 74)],
]

A1_MELODY: list[list[PhraseEvent]] = [
    [(0.0, "D5", 0.86, 79), (1.0, "F5", 0.55, 76), (1 + SWING, "G5", 0.24, 70), (2.0, "F5", 0.86, 78), (3.0, "D5", 0.54, 73), (3 + SWING, "C5", 0.24, 67)],
    [(0.0, "B4", 0.54, 71), (SWING, "D5", 0.24, 73), (1.0, "F5", 0.56, 78), (2.0, "G5", 0.54, 80), (2 + SWING, "F5", 0.24, 72), (3.0, "D5", 0.82, 75)],
    [(0.0, "Eb5", 0.86, 77), (1.0, "G5", 0.56, 80), (2.0, "Bb5", 0.54, 84), (2 + SWING, "A5", 0.24, 75), (3.0, "G5", 0.82, 79)],
    [(0.0, "A5", 0.54, 81), (SWING, "G5", 0.24, 74), (1.0, "F5", 0.78, 79), (2.0, "Eb5", 0.54, 76), (2 + SWING, "C5", 0.24, 69), (3.0, "A4", 0.82, 72)],
    [(0.0, "F5", 0.54, 76), (SWING, "A5", 0.24, 80), (1.0, "C6", 0.82, 84), (2.0, "B5", 0.54, 81), (2 + SWING, "G5", 0.24, 73), (3.0, "F5", 0.82, 77)],
    [(0.0, "G5", 0.56, 78), (1.0, "Bb5", 0.82, 83), (2.0, "A5", 0.54, 80), (2 + SWING, "F5", 0.24, 73), (3.0, "Eb5", 0.82, 76)],
    [(0.0, "D5", 0.54, 75), (SWING, "F5", 0.24, 78), (1.0, "Bb5", 0.82, 84), (2.0, "B5", 0.54, 80), (2 + SWING, "A5", 0.24, 72), (3.0, "G5", 0.82, 77)],
    [(0.0, "G5", 0.54, 78), (SWING, "Eb5", 0.24, 71), (1.0, "C5", 0.82, 74), (2.0, "A4", 0.54, 70), (2 + SWING, "C5", 0.24, 72), (3.0, "D5", 0.54, 75), (3 + SWING, "F5", 0.24, 76)],
]

A2_MELODY: list[list[PhraseEvent]] = [
    [(SWING, "F5", 0.24, 74), (1.0, "G5", 0.56, 78), (2.0, "A5", 0.54, 81), (2 + SWING, "Bb5", 0.24, 84), (3.0, "D6", 0.82, 87)],
    [(0.0, "B5", 0.54, 81), (SWING, "G5", 0.24, 74), (1.0, "F5", 0.82, 77), (2.0, "D5", 0.54, 72), (2 + SWING, "F5", 0.24, 75), (3.0, "Ab5", 0.82, 80)],
    [(0.0, "G5", 1.56, 80), (2.0, "Eb5", 0.54, 75), (2 + SWING, "G5", 0.24, 78), (3.0, "Bb5", 0.82, 84)],
    [(0.0, "A5", 0.54, 80), (SWING, "C6", 0.24, 84), (1.0, "Eb6", 0.82, 87), (2.0, "D6", 0.54, 82), (2 + SWING, "C6", 0.24, 76), (3.0, "A5", 0.82, 79)],
    [(0.0, "F5", 0.54, 75), (SWING, "E5", 0.24, 68), (1.0, "F5", 0.82, 76), (2.0, "B5", 0.54, 82), (2 + SWING, "D6", 0.24, 85), (3.0, "F6", 0.82, 88)],
    [(0.0, "Eb6", 0.54, 84), (SWING, "C6", 0.24, 77), (1.0, "Bb5", 0.82, 81), (2.0, "A5", 0.54, 79), (2 + SWING, "F5", 0.24, 71), (3.0, "Eb5", 0.82, 74)],
    [(0.0, "D5", 0.86, 75), (1.0, "F5", 0.54, 78), (1 + SWING, "G5", 0.24, 72), (2.0, "A5", 0.86, 80), (3.0, "C6", 0.82, 84)],
    [(0.0, "Bb5", 1.56, 84), (2.0, "A5", 0.54, 77), (2 + SWING, "F5", 0.24, 71), (3.0, "Eb5", 0.54, 73), (3 + SWING, "E5", 0.24, 70)],
]

BRIDGE_MELODY: list[list[PhraseEvent]] = [
    [(0.0, "F#5", 0.56, 79), (1.0, "A5", 0.54, 82), (1 + SWING, "C6", 0.24, 84), (2.0, "D6", 1.54, 87)],
    [(0.0, "C6", 0.54, 81), (SWING, "A5", 0.24, 75), (1.0, "F#5", 0.82, 79), (2.0, "E5", 0.54, 73), (2 + SWING, "F#5", 0.24, 76), (3.0, "A5", 0.82, 82)],
    [(0.0, "B5", 0.56, 82), (1.0, "D6", 0.54, 86), (1 + SWING, "F6", 0.24, 88), (2.0, "G6", 1.54, 90)],
    [(0.0, "F6", 0.54, 85), (SWING, "D6", 0.24, 78), (1.0, "B5", 0.82, 81), (2.0, "A5", 0.54, 75), (2 + SWING, "G5", 0.24, 72), (3.0, "F5", 0.82, 77)],
    [(0.0, "E5", 0.56, 76), (1.0, "G5", 0.54, 79), (1 + SWING, "Bb5", 0.24, 82), (2.0, "C6", 1.54, 85)],
    [(0.0, "Bb5", 0.54, 81), (SWING, "G5", 0.24, 74), (1.0, "E5", 0.82, 77), (2.0, "D5", 0.54, 72), (2 + SWING, "E5", 0.24, 74), (3.0, "G5", 0.82, 79)],
    [(0.0, "A5", 0.56, 80), (1.0, "C6", 0.54, 83), (1 + SWING, "Eb6", 0.24, 86), (2.0, "F6", 1.54, 88)],
    [(0.0, "Eb6", 0.54, 84), (SWING, "C6", 0.24, 77), (1.0, "A5", 0.82, 80), (2.0, "G5", 0.54, 74), (2 + SWING, "F5", 0.24, 72), (3.0, "D5", 0.54, 73), (3 + SWING, "C5", 0.24, 68)],
]

A3_MELODY: list[list[PhraseEvent]] = [
    [(0.0, "D5", 0.54, 77), (SWING, "F5", 0.24, 79), (1.0, "G5", 0.82, 81), (2.0, "F5", 0.54, 76), (2 + SWING, "D5", 0.24, 71), (3.0, "C5", 0.82, 73)],
    [(0.0, "B4", 0.54, 70), (SWING, "D5", 0.24, 73), (1.0, "F5", 0.82, 78), (2.0, "Ab5", 0.54, 81), (2 + SWING, "G5", 0.24, 74), (3.0, "F5", 0.82, 77)],
    [(0.0, "Eb5", 0.86, 76), (1.0, "G5", 0.54, 79), (1 + SWING, "Bb5", 0.24, 83), (2.0, "C6", 0.86, 85), (3.0, "G5", 0.82, 78)],
    [(0.0, "A5", 0.54, 80), (SWING, "G5", 0.24, 73), (1.0, "F5", 0.82, 77), (2.0, "Eb5", 0.54, 74), (2 + SWING, "C5", 0.24, 68), (3.0, "A4", 0.82, 71)],
    [(0.0, "F5", 0.54, 76), (SWING, "A5", 0.24, 79), (1.0, "C6", 0.82, 83), (2.0, "B5", 0.54, 80), (2 + SWING, "G5", 0.24, 72), (3.0, "D5", 0.82, 74)],
    [(0.0, "Eb5", 0.54, 74), (SWING, "G5", 0.24, 78), (1.0, "Bb5", 0.82, 82), (2.0, "A5", 0.54, 79), (2 + SWING, "F5", 0.24, 71), (3.0, "Eb5", 0.82, 74)],
    [(0.0, "D5", 0.86, 75), (1.0, "F5", 0.54, 78), (1 + SWING, "A5", 0.24, 81), (2.0, "G5", 0.54, 76), (2 + SWING, "F5", 0.24, 72), (3.0, "D5", 0.82, 74)],
    [(0.0, "G5", 0.54, 77), (SWING, "Eb5", 0.24, 71), (1.0, "C5", 0.82, 73), (2.0, "D5", 0.54, 76), (2 + SWING, "F5", 0.24, 79), (3.0, "Bb4", 0.92, 82)],
]


def add_sax(track: MidiTrack, rng: random.Random) -> None:
    channel = 2
    track.program_change(channel, 65)
    track.control_change(channel, 7, 103)
    track.control_change(channel, 10, 78)
    track.control_change(channel, 91, 22)
    track.control_change(channel, 11, 108)
    melody = INTRO_MELODY + A1_MELODY + A2_MELODY + BRIDGE_MELODY + A3_MELODY
    if len(melody) != TOTAL_BARS:
        raise AssertionError("Melody and chord form lengths do not match")
    for bar_index, phrase in enumerate(melody):
        for onset, name, length, velocity in phrase:
            human = rng.randint(-5, 7)
            start = bar_index * BAR_TICKS + beats(onset) + human
            duration = beats(length) + rng.randint(-8, 10)
            track.note(channel, note_number(name), start, duration, velocity + rng.randint(-2, 2))


def add_drums(track: MidiTrack, rng: random.Random) -> None:
    channel = 9
    track.control_change(channel, 7, 94)
    track.control_change(channel, 10, 64)
    section_starts = {4, 12, 20, 28}
    fill_bars = {11, 19, 27, 35}
    for bar_index in range(TOTAL_BARS):
        bar_tick = bar_index * BAR_TICKS
        if bar_index in section_starts:
            track.note(channel, 49, bar_tick, beats(0.65), 91)  # crash

        # Jazz ride: ding, ding-da, ding, ding-da.
        for beat_position, accent in (
            (0.0, 76), (1.0, 68), (1 + SWING, 58),
            (2.0, 75), (3.0, 68), (3 + SWING, 59),
        ):
            start = bar_tick + beats(beat_position) + rng.randint(-4, 5)
            track.note(channel, 51, start, beats(0.22), accent + rng.randint(-3, 3))

        for beat_position in (1.0, 3.0):
            start = bar_tick + beats(beat_position) + rng.randint(-3, 4)
            track.note(channel, 44, start, beats(0.16), 72 + rng.randint(-3, 3))

        # Feathered bass drum and sparse snare comping.
        for beat_position in (0.0, 2.0):
            track.note(channel, 36, bar_tick + beats(beat_position), beats(0.14), 42 + rng.randint(-2, 3))
        snare_positions = (1 + SWING, 3.0) if bar_index % 3 == 0 else ((2 + SWING,) if bar_index % 3 == 1 else (1.0, 3 + SWING))
        for beat_position in snare_positions:
            start = bar_tick + beats(beat_position) + rng.randint(-6, 6)
            track.note(channel, 38, start, beats(0.16), 48 + rng.randint(-4, 7))

        if bar_index in fill_bars:
            for beat_position, drum, velocity in ((3.0, 45, 69), (3 + SWING / 2, 47, 75), (3 + SWING, 50, 82)):
                track.note(channel, drum, bar_tick + beats(beat_position), beats(0.15), velocity)


def build_midi() -> bytes:
    rng = random.Random(20260819)
    conductor = MidiTrack("Conductor")
    piano = MidiTrack("Acoustic Piano")
    bass = MidiTrack("Walking Bass")
    sax = MidiTrack("Alto Sax")
    drums = MidiTrack("Jazz Drums")

    add_conductor(conductor)
    add_piano(piano, rng)
    add_bass(bass, rng)
    add_sax(sax, rng)
    add_drums(drums, rng)

    tracks = [conductor, piano, bass, sax, drums]
    header = b"MThd" + struct.pack(">IHHH", 6, 1, len(tracks), PPQ)
    return header + b"".join(track.build(TOTAL_TICKS) for track in tracks)


def read_variable_length(data: bytes, position: int) -> tuple[int, int]:
    value = 0
    while True:
        byte = data[position]
        position += 1
        value = (value << 7) | (byte & 0x7F)
        if not byte & 0x80:
            return value, position


def inspect_midi(path: Path) -> dict[str, int | float | list[str]]:
    data = path.read_bytes()
    if data[:4] != b"MThd":
        raise ValueError("Missing MIDI header")
    header_length, midi_format, track_count, division = struct.unpack(">IHHH", data[4:14])
    if header_length != 6 or midi_format != 1 or division != PPQ:
        raise ValueError("Unexpected MIDI header values")

    position = 14
    names: list[str] = []
    note_ons = 0
    maximum_tick = 0
    parsed_tracks = 0
    for _ in range(track_count):
        if data[position:position + 4] != b"MTrk":
            raise ValueError("Missing track chunk")
        length = int.from_bytes(data[position + 4:position + 8], "big")
        payload = data[position + 8:position + 8 + length]
        position += 8 + length
        parsed_tracks += 1
        cursor = 0
        absolute_tick = 0
        while cursor < len(payload):
            delta, cursor = read_variable_length(payload, cursor)
            absolute_tick += delta
            status = payload[cursor]
            cursor += 1
            if status == 0xFF:
                meta_type = payload[cursor]
                cursor += 1
                meta_length, cursor = read_variable_length(payload, cursor)
                meta_payload = payload[cursor:cursor + meta_length]
                cursor += meta_length
                if meta_type == 0x03:
                    names.append(meta_payload.decode("utf-8"))
                if meta_type == 0x2F:
                    break
            elif status in (0xF0, 0xF7):
                event_length, cursor = read_variable_length(payload, cursor)
                cursor += event_length
            else:
                event_type = status & 0xF0
                data_length = 1 if event_type in (0xC0, 0xD0) else 2
                event_data = payload[cursor:cursor + data_length]
                cursor += data_length
                if event_type == 0x90 and len(event_data) == 2 and event_data[1] > 0:
                    note_ons += 1
            maximum_tick = max(maximum_tick, absolute_tick)

    if parsed_tracks != track_count or position != len(data):
        raise ValueError("MIDI chunk count or file length mismatch")
    seconds = maximum_tick / PPQ * 60 / BPM
    return {
        "format": midi_format,
        "tracks": track_count,
        "track_names": names,
        "bars": TOTAL_BARS,
        "bpm": BPM,
        "duration_seconds": round(seconds, 2),
        "note_events": note_ons,
        "file_bytes": len(data),
    }


def main() -> None:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_bytes(build_midi())
    report = inspect_midi(OUTPUT_PATH)
    print(json.dumps({"file": str(OUTPUT_PATH), **report}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
