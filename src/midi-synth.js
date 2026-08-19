const LOOK_AHEAD_SECONDS = 0.35;
const SCHEDULER_INTERVAL_MS = 60;
const HIT_SOUND_PROFILES = {
  PERFECT: { frequency: 1174.66, level: 0.115, duration: 0.13, click: 0.085, overtone: 0.34 },
  GREAT: { frequency: 880, level: 0.09, duration: 0.105, click: 0.062, overtone: 0.2 },
  GOOD: { frequency: 659.25, level: 0.068, duration: 0.085, click: 0.044, overtone: 0.12 },
};

function midiToFrequency(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export class MidiSynth {
  constructor() {
    this.context = null;
    this.master = null;
    this.hitBus = null;
    this.hitBuffers = null;
    this.hitPanners = [];
    this.compressor = null;
    this.musicAnalyser = null;
    this.frequencyData = null;
    this.noiseBuffer = null;
    this.backingBuffer = null;
    this.backingOffset = 0;
    this.events = [];
    this.eventIndex = 0;
    this.startAt = 0;
    this.scheduler = null;
    this.activeNodes = new Set();
    this.playing = false;
  }

  async prepare() {
    if (!this.context) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error("이 브라우저는 Web Audio를 지원하지 않습니다.");

      this.context = new AudioContextClass({ latencyHint: "interactive" });
      this.master = this.context.createGain();
      this.master.gain.value = 0.72;
      this.hitBus = this.context.createGain();
      this.hitBus.gain.value = 0.9;
      this.compressor = this.context.createDynamicsCompressor();
      this.compressor.threshold.value = -18;
      this.compressor.knee.value = 16;
      this.compressor.ratio.value = 5;
      this.compressor.attack.value = 0.004;
      this.compressor.release.value = 0.22;
      this.musicAnalyser = this.context.createAnalyser();
      this.musicAnalyser.fftSize = 256;
      this.musicAnalyser.smoothingTimeConstant = 0.72;
      this.musicAnalyser.minDecibels = -82;
      this.musicAnalyser.maxDecibels = -16;
      this.frequencyData = new Uint8Array(this.musicAnalyser.frequencyBinCount);
      this.master.connect(this.musicAnalyser).connect(this.compressor).connect(this.context.destination);
      this.hitBus.connect(this.compressor);
      this.noiseBuffer = this.createNoiseBuffer();
      this.hitBuffers = this.createHitBuffers();
      this.hitPanners = Array.from({ length: 4 }, (_, lane) => {
        const panner = this.context.createStereoPanner();
        panner.pan.value = (lane - 1.5) * 0.22;
        panner.connect(this.hitBus);
        return panner;
      });
    }

    if (this.context.state === "suspended") await this.context.resume();
  }

  async start(events, leadInSeconds = 3) {
    await this.prepare();
    this.stop();
    this.events = events;
    this.eventIndex = 0;
    this.startAt = this.context.currentTime + leadInSeconds;
    this.playing = true;
    if (this.backingBuffer) {
      const source = this.context.createBufferSource();
      source.buffer = this.backingBuffer;
      source.connect(this.master);
      this.trackNode(source);
      source.start(this.startAt, this.backingOffset);
    } else {
      this.scheduleWindow();
      this.scheduler = window.setInterval(() => this.scheduleWindow(), SCHEDULER_INTERVAL_MS);
    }
    return this.startAt;
  }

  async playEnterCue() {
    await this.prepare();
    const start = this.context.currentTime + 0.008;
    const frequencies = [293.66, 440, 659.25];

    frequencies.forEach((frequency, index) => {
      const when = start + index * 0.075;
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      oscillator.type = index === frequencies.length - 1 ? "sine" : "triangle";
      oscillator.frequency.setValueAtTime(frequency, when);
      oscillator.frequency.exponentialRampToValueAtTime(frequency * 1.12, when + 0.16);
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(index === frequencies.length - 1 ? 0.085 : 0.052, when + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.24);
      oscillator.connect(gain).connect(this.hitBus);
      oscillator.start(when);
      oscillator.stop(when + 0.25);
    });
  }

  playCountdownCue(value) {
    if (!this.context || !this.hitBus || !this.playing) return;
    const isGo = value === "GO";
    const count = Number(value);
    const frequencies = { 3: 440, 2: 523.25, 1: 659.25 };
    const frequency = isGo ? 987.77 : frequencies[count];
    if (!frequency) return;

    const when = this.context.currentTime + 0.006;
    const duration = isGo ? 0.28 : 0.14;
    const oscillator = this.context.createOscillator();
    const overtone = this.context.createOscillator();
    const gain = this.context.createGain();
    const overtoneGain = this.context.createGain();
    oscillator.type = isGo ? "sawtooth" : "square";
    oscillator.frequency.setValueAtTime(frequency, when);
    overtone.type = "sine";
    overtone.frequency.setValueAtTime(frequency * 2, when);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(isGo ? 0.09 : 0.064, when + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    overtoneGain.gain.setValueAtTime(0.0001, when);
    overtoneGain.gain.exponentialRampToValueAtTime(isGo ? 0.028 : 0.018, when + 0.008);
    overtoneGain.gain.exponentialRampToValueAtTime(0.0001, when + duration * 0.72);
    oscillator.connect(gain).connect(this.hitBus);
    overtone.connect(overtoneGain).connect(this.hitBus);
    oscillator.start(when);
    overtone.start(when);
    oscillator.stop(when + duration + 0.01);
    overtone.stop(when + duration + 0.01);
  }

  setBackingTrack(audioBuffer, offset = 0) {
    this.backingBuffer = audioBuffer || null;
    this.backingOffset = Math.max(0, offset);
  }

  get songTime() {
    if (!this.context || !this.startAt) return 0;
    const reportedLatency = this.context.outputLatency || this.context.baseLatency || 0;
    const playbackLatency = clamp(reportedLatency, 0, 0.08);
    return this.context.currentTime - this.startAt - playbackLatency;
  }

  getAudioEnergy() {
    if (!this.musicAnalyser || !this.frequencyData || !this.context) {
      return { bass: 0, mid: 0, high: 0, overall: 0 };
    }

    this.musicAnalyser.getByteFrequencyData(this.frequencyData);
    const nyquist = this.context.sampleRate / 2;
    const averageBand = (minimum, maximum) => {
      const start = Math.max(0, Math.floor((minimum / nyquist) * this.frequencyData.length));
      const end = Math.min(
        this.frequencyData.length,
        Math.max(start + 1, Math.ceil((maximum / nyquist) * this.frequencyData.length)),
      );
      let total = 0;
      for (let index = start; index < end; index += 1) total += this.frequencyData[index];
      return total / (end - start) / 255;
    };
    const shapeEnergy = (value, gain) => clamp((value - 0.035) * gain, 0, 1);
    const bass = shapeEnergy(averageBand(35, 190), 1.72);
    const mid = shapeEnergy(averageBand(190, 2200), 1.48);
    const high = shapeEnergy(averageBand(2200, 9000), 1.65);
    return {
      bass,
      mid,
      high,
      overall: clamp(bass * 0.48 + mid * 0.34 + high * 0.18, 0, 1),
    };
  }

  stop() {
    this.playing = false;
    if (this.scheduler) window.clearInterval(this.scheduler);
    this.scheduler = null;
    for (const node of this.activeNodes) {
      try {
        node.stop();
      } catch {
        // A voice that already ended needs no further cleanup.
      }
    }
    this.activeNodes.clear();
  }

  playHitFeedback(judgement, lane = 0) {
    if (!this.context || !this.hitBuffers || !this.playing) return;
    const buffer = this.hitBuffers[judgement];
    const panner = this.hitPanners[clamp(Math.round(lane), 0, 3)];
    if (!buffer || !panner) return;
    const when = this.context.currentTime + 0.003;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(panner);
    this.trackNode(source);
    source.start(when);
  }

  scheduleWindow() {
    if (!this.playing || !this.context) return;
    const windowEnd = this.context.currentTime + LOOK_AHEAD_SECONDS;

    while (this.eventIndex < this.events.length) {
      const event = this.events[this.eventIndex];
      const eventTime = this.startAt + event.time;
      if (eventTime > windowEnd) break;
      if (eventTime > this.context.currentTime - 0.08) this.scheduleEvent(event, eventTime);
      this.eventIndex += 1;
    }
  }

  scheduleEvent(event, requestedTime) {
    const when = Math.max(requestedTime, this.context.currentTime + 0.005);
    if (event.percussion) {
      this.scheduleDrum(event, when);
      return;
    }

    const trackName = event.trackName.toLowerCase();
    const isBass = trackName.includes("bass") || event.midi < 48;
    const isPad = trackName.includes("pad") || trackName.includes("chord");
    const isLead = trackName.includes("lead") || trackName.includes("sax");
    const duration = clamp(event.duration, 0.07, isPad ? 2.4 : 1.1);
    const oscillator = this.context.createOscillator();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    const level = clamp(event.velocity, 0.08, 1);

    oscillator.type = isBass ? "square" : isLead ? "sawtooth" : isPad ? "triangle" : "square";
    oscillator.frequency.setValueAtTime(midiToFrequency(event.midi), when);
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(isBass ? 720 : isPad ? 1600 : 3200, when);
    filter.Q.value = isLead ? 2.4 : 0.8;

    const peak = level * (isBass ? 0.045 : isLead ? 0.025 : isPad ? 0.012 : 0.017);
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(peak, when + (isPad ? 0.055 : 0.008));
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration + 0.08);

    oscillator.connect(filter).connect(gain).connect(this.master);
    this.trackNode(oscillator);
    oscillator.start(when);
    oscillator.stop(when + duration + 0.1);
  }

  scheduleDrum(event, when) {
    if (event.midi === 35 || event.midi === 36) {
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(125, when);
      oscillator.frequency.exponentialRampToValueAtTime(45, when + 0.12);
      gain.gain.setValueAtTime(0.075 * clamp(event.velocity, 0.15, 1), when);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.17);
      oscillator.connect(gain).connect(this.master);
      this.trackNode(oscillator);
      oscillator.start(when);
      oscillator.stop(when + 0.18);
      return;
    }

    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    const cymbal = event.midi >= 42;
    source.buffer = this.noiseBuffer;
    filter.type = cymbal ? "highpass" : "bandpass";
    filter.frequency.value = cymbal ? 5200 : 1800;
    filter.Q.value = cymbal ? 0.5 : 1.1;
    gain.gain.setValueAtTime((cymbal ? 0.022 : 0.048) * clamp(event.velocity, 0.15, 1), when);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + (cymbal ? 0.055 : 0.16));
    source.connect(filter).connect(gain).connect(this.master);
    this.trackNode(source);
    source.start(when);
    source.stop(when + 0.2);
  }

  createNoiseBuffer() {
    const length = Math.floor(this.context.sampleRate * 0.25);
    const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < length; index += 1) {
      data[index] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  createHitBuffers() {
    return Object.fromEntries(
      Object.entries(HIT_SOUND_PROFILES).map(([name, profile]) => {
        const sampleRate = this.context.sampleRate;
        const length = Math.ceil((profile.duration + 0.012) * sampleRate);
        const buffer = this.context.createBuffer(1, length, sampleRate);
        const data = buffer.getChannelData(0);
        let phase = 0;

        for (let index = 0; index < length; index += 1) {
          const time = index / sampleRate;
          const progress = Math.min(1, time / profile.duration);
          const frequency = profile.frequency * (1 - progress * 0.22);
          phase += (Math.PI * 2 * frequency) / sampleRate;
          const attack = Math.min(1, time / 0.003);
          const bodyEnvelope = attack * Math.exp(-progress * 5.2);
          const body =
            (Math.sin(phase) + Math.sin(phase * 1.5) * profile.overtone) *
            profile.level *
            bodyEnvelope;
          const transient =
            (Math.random() * 2 - 1) * profile.click * Math.exp(-time / 0.009);
          data[index] = clamp(body + transient, -1, 1);
        }

        return [name, buffer];
      }),
    );
  }

  trackNode(node) {
    this.activeNodes.add(node);
    node.addEventListener("ended", () => this.activeNodes.delete(node), { once: true });
  }
}
