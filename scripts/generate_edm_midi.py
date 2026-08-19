from __future__ import annotations

import json
import random
import struct
from pathlib import Path

from generate_jazz_midi import MidiTrack, note_number, read_variable_length


PPQ = 480
BPM = 150
BAR_TICKS = PPQ * 4
TOTAL_BARS = 48
TOTAL_TICKS = TOTAL_BARS * BAR_TICKS
OUTPUT_PATH = Path(__file__).resolve().parents[1] / "output" / "neon_velocity_edm.mid"


CHORDS = ("F#m", "D", "A", "E")

CHORD_NOTES = {
    "F#m": [note_number(n) for n in ("F#3", "A3", "C#4", "E4", "F#4")],
    "D": [note_number(n) for n in ("D3", "A3", "C#4", "F#4", "A4")],
    "A": [note_number(n) for n in ("A2", "E3", "A3", "C#4", "E4")],
    "E": [note_number(n) for n in ("E3", "G#3", "B3", "F#4", "B4")],
}

ARP_NOTES = {
    "F#m": [note_number(n) for n in ("F#4", "A4", "C#5", "E5", "F#5")],
    "D": [note_number(n) for n in ("D4", "F#4", "A4", "C#5", "D5")],
    "A": [note_number(n) for n in ("A3", "C#4", "E4", "A4", "C#5")],
    "E": [note_number(n) for n in ("E4", "G#4", "B4", "E5", "F#5")],
}

BASS_ROOTS = {
    "F#m": note_number("F#2"),
    "D": note_number("D2"),
    "A": note_number("A1"),
    "E": note_number("E2"),
}


def beats(value: float) -> int:
    return round(value * PPQ)


def chord_for_bar(bar: int) -> str:
    if bar == TOTAL_BARS - 1:
        return "F#m"
    return CHORDS[bar % len(CHORDS)]


def add_note(
    track: MidiTrack,
    channel: int,
    pitch: int,
    bar: int,
    onset: float,
    duration: float,
    velocity: int,
) -> None:
    track.note(
        channel,
        pitch,
        bar * BAR_TICKS + beats(onset),
        beats(duration),
        velocity,
    )


def add_conductor(track: MidiTrack) -> None:
    tempo = round(60_000_000 / BPM)
    track.add_meta(0, 0x51, tempo.to_bytes(3, "big"))
    track.add_meta(0, 0x58, bytes([4, 2, 24, 8]))
    track.add_meta(0, 0x59, bytes([3, 0]))  # F-sharp minor shares A major's signature.
    track.add_meta(0, 0x01, b"Original EDM composition: Neon Velocity")
    for bar, marker in (
        (0, "Intro"),
        (4, "Build"),
        (8, "Drop 1"),
        (24, "Breakdown"),
        (28, "Build 2"),
        (32, "Drop 2"),
        (47, "Final Hit"),
        (48, "End"),
    ):
        track.add_meta(bar * BAR_TICKS, 0x06, marker.encode("ascii"))


def add_pad(track: MidiTrack) -> None:
    channel = 0
    track.program_change(channel, 89)  # Warm pad
    track.control_change(channel, 7, 78)
    track.control_change(channel, 10, 44)
    track.control_change(channel, 91, 58)
    track.control_change(channel, 93, 24)

    for bar in range(TOTAL_BARS):
        chord = chord_for_bar(bar)
        is_intro = bar < 8
        is_break = 24 <= bar < 32
        is_final = bar == TOTAL_BARS - 1
        if is_intro or is_break or is_final:
            velocity = 40 + min(bar, 7) * 3 if is_intro else 55
            # Leave room for the tiny chord strum so every note-off precedes End-of-Track.
            duration = 3.88 if not is_final else 3.82
            notes = CHORD_NOTES[chord]
            for index, pitch in enumerate(notes):
                add_note(track, channel, pitch, bar, 0.0 + index * 0.015, duration, velocity + index)
        else:
            # A quiet sustained layer glues the drop together under the stabs.
            for index, pitch in enumerate(CHORD_NOTES[chord][1:]):
                add_note(track, channel, pitch, bar, 0.08 + index * 0.01, 3.72, 34 + index)


def add_saw_stabs(track: MidiTrack, rng: random.Random) -> None:
    channel = 1
    track.program_change(channel, 81)  # Sawtooth lead used polyphonically
    track.control_change(channel, 7, 94)
    track.control_change(channel, 10, 76)
    track.control_change(channel, 91, 32)

    for bar in range(TOTAL_BARS):
        chord = chord_for_bar(bar)
        is_drop = 8 <= bar < 24 or 32 <= bar < 47
        if is_drop:
            onsets = (0.22, 1.22, 2.22, 3.22)
        elif 28 <= bar < 32:
            onsets = (0.25, 2.25) if bar < 30 else (0.22, 1.22, 2.22, 3.22)
        elif bar == 47:
            onsets = (0.0,)
        else:
            continue

        for onset in onsets:
            length = 0.58 if bar != 47 else 3.86
            base_velocity = 72 + (8 if bar >= 32 else 0)
            for index, pitch in enumerate(CHORD_NOTES[chord][1:]):
                add_note(
                    track,
                    channel,
                    pitch + (12 if index == 3 and bar >= 32 else 0),
                    bar,
                    onset + index * 0.008,
                    length,
                    base_velocity + rng.randint(-3, 3),
                )


def add_bass(track: MidiTrack, rng: random.Random) -> None:
    channel = 2
    track.program_change(channel, 38)  # Synth bass 1
    track.control_change(channel, 7, 112)
    track.control_change(channel, 10, 64)
    track.control_change(channel, 91, 10)

    for bar in range(TOTAL_BARS):
        chord = chord_for_bar(bar)
        root = BASS_ROOTS[chord]
        is_drop = 8 <= bar < 24 or 32 <= bar < 47
        is_build = 4 <= bar < 8 or 28 <= bar < 32
        if is_drop:
            for index, onset in enumerate((0.5, 1.5, 2.5, 3.5)):
                pitch = root + (12 if bar >= 32 and index == 3 else 0)
                add_note(track, channel, pitch, bar, onset, 0.38, 101 + rng.randint(-4, 4))
            if bar % 4 == 3:
                add_note(track, channel, root + 12, bar, 3.0, 0.28, 92)
        elif is_build:
            onsets = (0.5, 2.5) if bar in (4, 5, 28, 29) else (0.5, 1.5, 2.5, 3.5)
            for onset in onsets:
                add_note(track, channel, root, bar, onset, 0.38, 80 + (bar % 4) * 4)
        elif bar == 47:
            add_note(track, channel, root, bar, 0.0, 3.85, 112)


def add_arpeggiator(track: MidiTrack, rng: random.Random) -> None:
    channel = 3
    track.program_change(channel, 80)  # Square lead / bright pluck
    track.control_change(channel, 7, 74)
    track.control_change(channel, 10, 34)
    track.control_change(channel, 91, 44)
    pattern = (0, 1, 2, 1, 3, 2, 4, 2, 0, 2, 3, 2, 4, 3, 2, 1)

    for bar in range(TOTAL_BARS):
        if bar == 47:
            continue
        chord = chord_for_bar(bar)
        notes = ARP_NOTES[chord]
        is_drop = 8 <= bar < 24 or 32 <= bar < 47
        step = 0.25 if is_drop or bar in (7, 31) else 0.5
        count = 16 if step == 0.25 else 8
        velocity_base = 58 if bar < 8 else (66 if 24 <= bar < 32 else 71)
        for index in range(count):
            pattern_index = pattern[index if step == 0.25 else index * 2]
            pitch = notes[pattern_index]
            if bar >= 32 and index in (6, 14):
                pitch += 12
            add_note(
                track,
                channel,
                pitch,
                bar,
                index * step,
                step * 0.68,
                velocity_base + (7 if index % 4 == 0 else 0) + rng.randint(-2, 2),
            )


LeadEvent = tuple[float, str, float, int]

DROP_MELODY: list[list[LeadEvent]] = [
    [(0.0, "F#5", 0.72, 96), (1.0, "C#5", 0.42, 86), (1.5, "E5", 0.42, 89), (2.0, "F#5", 0.72, 98), (3.0, "A5", 0.72, 103)],
    [(0.0, "A5", 0.42, 102), (0.5, "F#5", 0.42, 92), (1.0, "E5", 0.72, 94), (2.0, "D5", 0.72, 91), (3.0, "C#5", 0.42, 87), (3.5, "E5", 0.42, 91)],
    [(0.0, "C#5", 0.42, 89), (0.5, "E5", 0.42, 92), (1.0, "F#5", 0.72, 97), (2.0, "E5", 0.42, 91), (2.5, "C#5", 0.42, 86), (3.0, "B4", 0.72, 84)],
    [(0.0, "B4", 0.42, 85), (0.5, "E5", 0.42, 91), (1.0, "F#5", 0.72, 96), (2.0, "G#5", 0.72, 100), (3.0, "E5", 0.72, 92)],
    [(0.0, "C#5", 0.42, 88), (0.5, "F#5", 0.42, 95), (1.0, "A5", 0.72, 103), (2.0, "C#6", 0.42, 108), (2.5, "B5", 0.42, 100), (3.0, "A5", 0.72, 98)],
    [(0.0, "F#5", 0.72, 96), (1.0, "A5", 0.42, 101), (1.5, "F#5", 0.42, 93), (2.0, "E5", 0.72, 91), (3.0, "D5", 0.72, 89)],
    [(0.0, "E5", 0.42, 91), (0.5, "F#5", 0.42, 96), (1.0, "A5", 0.72, 102), (2.0, "C#6", 0.72, 107), (3.0, "B5", 0.72, 100)],
    [(0.0, "G#5", 0.42, 96), (0.5, "E5", 0.42, 90), (1.0, "F#5", 0.72, 97), (2.0, "E5", 0.42, 91), (2.5, "C#5", 0.42, 86), (3.0, "E5", 0.42, 91), (3.5, "F#5", 0.42, 96)],
]


def add_lead_phrase(
    track: MidiTrack,
    rng: random.Random,
    start_bar: int,
    repeat_count: int,
    intense: bool,
) -> None:
    channel = 4
    for repeat in range(repeat_count):
        for phrase_bar, events in enumerate(DROP_MELODY):
            bar = start_bar + repeat * 8 + phrase_bar
            for onset, name, duration, velocity in events:
                pitch = note_number(name)
                if intense and repeat == 1 and phrase_bar in (0, 4) and pitch <= note_number("A5"):
                    pitch += 12
                add_note(track, channel, pitch, bar, onset, duration, velocity + (5 if intense else 0) + rng.randint(-2, 2))
                if intense and duration >= 0.7 and phrase_bar % 2 == 0:
                    add_note(track, channel, pitch - 12, bar, onset, duration, velocity - 22)


def add_lead(track: MidiTrack, rng: random.Random) -> None:
    channel = 4
    track.program_change(channel, 81)  # Saw lead
    track.control_change(channel, 7, 106)
    track.control_change(channel, 10, 88)
    track.control_change(channel, 91, 36)
    track.control_change(channel, 93, 18)

    # Pickup into the first drop.
    for onset, name, duration, velocity in (
        (2.0, "C#5", 0.42, 78),
        (2.5, "E5", 0.42, 84),
        (3.0, "F#5", 0.42, 90),
        (3.5, "A5", 0.42, 96),
    ):
        add_note(track, channel, note_number(name), 7, onset, duration, velocity)

    add_lead_phrase(track, rng, 8, 2, intense=False)

    # Long, airy melody during the breakdown.
    breakdown = [
        (24, 0.0, "F#5", 3.75, 82),
        (25, 0.0, "E5", 1.75, 78),
        (25, 2.0, "D5", 1.75, 76),
        (26, 0.0, "C#5", 3.75, 80),
        (27, 0.0, "B4", 1.75, 74),
        (27, 2.0, "C#5", 1.75, 78),
        (28, 0.0, "F#5", 1.75, 84),
        (28, 2.0, "A5", 1.75, 88),
        (29, 0.0, "F#5", 3.75, 86),
        (30, 0.0, "E5", 1.75, 82),
        (30, 2.0, "F#5", 1.75, 88),
        (31, 0.0, "G#5", 0.72, 90),
        (31, 1.0, "A5", 0.72, 94),
        (31, 2.0, "C#6", 0.72, 100),
        (31, 3.0, "E6", 0.72, 106),
    ]
    for bar, onset, name, duration, velocity in breakdown:
        add_note(track, channel, note_number(name), bar, onset, duration, velocity)

    add_lead_phrase(track, rng, 32, 2, intense=True)
    add_note(track, channel, note_number("F#5"), 47, 0.0, 3.88, 112)
    add_note(track, channel, note_number("C#6"), 47, 0.0, 3.88, 98)


def add_drums(track: MidiTrack, rng: random.Random) -> None:
    channel = 9
    track.control_change(channel, 7, 112)
    track.control_change(channel, 10, 64)
    track.control_change(channel, 91, 18)

    def hit(bar: int, onset: float, drum: int, velocity: int, duration: float = 0.12) -> None:
        add_note(track, channel, drum, bar, onset, duration, velocity)

    for bar in range(TOTAL_BARS):
        is_drop = 8 <= bar < 24 or 32 <= bar < 47
        is_build = 4 <= bar < 8 or 28 <= bar < 32

        if bar in (8, 24, 32, 47):
            hit(bar, 0.0, 49, 112 if bar in (8, 32, 47) else 94, 0.72)

        if is_drop:
            for beat in (0.0, 1.0, 2.0, 3.0):
                hit(bar, beat, 36, 116 if beat in (0.0, 2.0) else 108, 0.16)
            for beat in (1.0, 3.0):
                hit(bar, beat, 39, 104, 0.16)
                hit(bar, beat, 38, 88, 0.14)
            for half in range(8):
                onset = half * 0.5
                drum = 46 if half % 2 == 1 else 42
                velocity = 72 + (12 if half % 4 == 1 else 0) + rng.randint(-3, 3)
                hit(bar, onset, drum, velocity, 0.12)
            for onset in (0.75, 1.75, 2.75, 3.75):
                hit(bar, onset, 82, 51 + rng.randint(-3, 3), 0.08)

        elif is_build:
            kick_beats = (0.0, 2.0) if bar in (4, 5, 28, 29) else (0.0, 1.0, 2.0, 3.0)
            for beat in kick_beats:
                hit(bar, beat, 36, 88 + (bar % 4) * 5, 0.15)
            for half in range(8):
                hit(bar, half * 0.5, 42, 50 + half * 3, 0.09)
            if bar not in (7, 31):
                for beat in (1.0, 3.0):
                    hit(bar, beat, 39, 72 + (bar % 4) * 5, 0.14)

        elif 2 <= bar < 4:
            for onset in (1.5, 3.5):
                hit(bar, onset, 42, 46 + bar * 4, 0.10)

        if bar in (7, 31):
            # Accelerating snare roll into each drop.
            for step in range(8):
                hit(bar, step * 0.5, 38, 55 + step * 4, 0.08)
            for step in range(8):
                hit(bar, 2.0 + step * 0.25, 38, 76 + step * 5, 0.07)

        if bar in (23, 46):
            for onset, drum, velocity in (
                (3.0, 45, 84),
                (3.25, 47, 90),
                (3.5, 48, 98),
                (3.75, 50, 108),
            ):
                hit(bar, onset, drum, velocity, 0.10)

    # A single, decisive final hit.
    hit(47, 0.0, 36, 124, 0.25)
    hit(47, 0.0, 39, 112, 0.18)


def build_midi() -> bytes:
    rng = random.Random(150_2026)
    conductor = MidiTrack("Conductor")
    pad = MidiTrack("Warm Pad")
    stabs = MidiTrack("Saw Chords")
    bass = MidiTrack("Offbeat Synth Bass")
    arp = MidiTrack("16th Arpeggiator")
    lead = MidiTrack("EDM Lead")
    drums = MidiTrack("EDM Drums")

    add_conductor(conductor)
    add_pad(pad)
    add_saw_stabs(stabs, rng)
    add_bass(bass, rng)
    add_arpeggiator(arp, rng)
    add_lead(lead, rng)
    add_drums(drums, rng)

    tracks = [conductor, pad, stabs, bass, arp, lead, drums]
    header = b"MThd" + struct.pack(">IHHH", 6, 1, len(tracks), PPQ)
    return header + b"".join(track.build(TOTAL_TICKS) for track in tracks)


def inspect_midi(path: Path) -> dict[str, object]:
    data = path.read_bytes()
    if data[:4] != b"MThd":
        raise ValueError("Missing MIDI header")
    header_length, midi_format, track_count, division = struct.unpack(">IHHH", data[4:14])
    if (header_length, midi_format, division) != (6, 1, PPQ):
        raise ValueError("Unexpected MIDI header")

    position = 14
    names: list[str] = []
    note_ons = 0
    max_tick = 0
    for _ in range(track_count):
        if data[position:position + 4] != b"MTrk":
            raise ValueError("Missing track chunk")
        length = int.from_bytes(data[position + 4:position + 8], "big")
        payload = data[position + 8:position + 8 + length]
        position += 8 + length
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
                    if cursor != len(payload):
                        raise ValueError("Track contains events after End-of-Track")
                    break
            elif status in (0xF0, 0xF7):
                event_length, cursor = read_variable_length(payload, cursor)
                cursor += event_length
            else:
                event_type = status & 0xF0
                event_length = 1 if event_type in (0xC0, 0xD0) else 2
                event_data = payload[cursor:cursor + event_length]
                cursor += event_length
                if event_type == 0x90 and len(event_data) == 2 and event_data[1] > 0:
                    note_ons += 1
            max_tick = max(max_tick, absolute_tick)

    if position != len(data):
        raise ValueError("MIDI chunk length mismatch")
    return {
        "format": midi_format,
        "tracks": track_count,
        "track_names": names,
        "bars": TOTAL_BARS,
        "bpm": BPM,
        "duration_seconds": round(max_tick / PPQ * 60 / BPM, 2),
        "note_events": note_ons,
        "file_bytes": len(data),
    }


def main() -> None:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_bytes(build_midi())
    print(json.dumps({"file": str(OUTPUT_PATH), **inspect_midi(OUTPUT_PATH)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
