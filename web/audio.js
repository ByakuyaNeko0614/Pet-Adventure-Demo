'use strict';
var GameSound = class {
  static homeTracks = {
    cottage: {url:'web/assets/home-theme.mp3', name:'午後小屋 · 輕柔音樂盒'},
    conservatory: {url:'web/assets/conservatory-theme.mp3', name:'玻璃花房 · 葉間晨光'},
    loft: {url:'web/assets/loft-theme.mp3', name:'月光閣樓 · 月下搖籃曲'}
  };
  constructor(options = {}) {
    this.theme = options.theme || 'adventure';
    this.enabled = true; this.music = true; this.effects = true; this.volume = .3;
    this.context = null;
    this.room = 'cottage';
    this.trackName = GameSound.homeTracks.cottage.name;
    this.track = new Audio(this.theme === 'home' ? GameSound.homeTracks.cottage.url : 'web/assets/forest-theme.mp3');
    this.track.loop = true; this.track.preload = 'none';
    try { const saved = JSON.parse(localStorage.getItem('pet-treasure-audio') || '{}');
      this.enabled = saved.enabled !== false; this.music = saved.music !== false; this.effects = saved.effects !== false;
      this.volume = Number.isFinite(saved.volume) ? Math.max(0, Math.min(1, saved.volume)) : .3;
    } catch {}
  }
  save() { try { localStorage.setItem('pet-treasure-audio', JSON.stringify({enabled:this.enabled,music:this.music,effects:this.effects,volume:this.volume})); } catch {} }
  get waiting() { return this.enabled && this.music && this.track.paused && !this.track.error; }
  setRoom(room) {
    if (this.theme !== 'home' || this.room === room || !Object.hasOwn(GameSound.homeTracks, room)) return;
    const {url, name} = GameSound.homeTracks[room];
    this.room = room;
    this.trackName = name;
    this.track.src = url;
    void this.syncMusic();
  }
  start(onChange, toggle) {
    document.body.append(this.track);
    for (const event of ['playing','pause','error']) this.track.addEventListener(event, onChange);
    const activate = event => {
      if (!this.enabled || (event.target && toggle.contains(event.target)) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (this.waiting || this.effects && this.context?.state !== 'running') void this.unlock().then(onChange);
    };
    document.addEventListener('pointerup', activate);
    document.addEventListener('keydown', activate);
    document.addEventListener('click', activate);
    document.addEventListener('account-locked', () => {
      this.enabled = false;
      this.track.pause();
      if (this.context) void this.context.suspend().catch(() => {});
    }, { once: true });
    void this.syncMusic().then(onChange);
    onChange();
  }
  enable() { this.enabled = true; this.save(); return this.unlock(); }
  unlock() {
    const track = this.syncMusic(); // Call play directly in the trusted gesture.
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (this.enabled && this.effects && AudioContext) {
      if (!this.context) {
        this.context = new AudioContext();
        this.master = this.context.createGain();
        this.master.gain.value = this.volume;
        this.master.connect(this.context.destination);
      }
      if (this.context.state !== 'running') void this.context.resume().catch(() => {});
    }
    return track;
  }
  disable() { this.enabled = false; this.save(); this.track.pause(); if (this.context) void this.context.suspend().catch(() => {}); }
  async syncMusic() {
    this.track.volume = this.volume * .65;
    if (!this.enabled || !this.music) this.track.pause();
    else if (this.track.paused && !this.track.error) {
      try { await this.track.play(); } catch { /* Retry on the next user gesture. */ }
    }
  }
  configure(music, effects, volume) {
    this.music = music; this.effects = effects; this.volume = Math.max(0, Math.min(1, volume));
    if (this.master) this.master.gain.setTargetAtTime(this.volume, this.context.currentTime, .04);
    this.save();
    void this.unlock();
  }
  tone(frequency, when, duration, gain = .12, type = 'sine') {
    const oscillator = this.context.createOscillator(); const envelope = this.context.createGain();
    oscillator.type = type; oscillator.frequency.value = frequency;
    envelope.gain.setValueAtTime(0, when); envelope.gain.linearRampToValueAtTime(gain, when + .015);
    envelope.gain.exponentialRampToValueAtTime(.0001, when + duration);
    oscillator.connect(envelope); envelope.connect(this.master); oscillator.start(when); oscillator.stop(when + duration + .02);
    oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); };
  }
  footstep(terrain) {
    if (!this.enabled || !this.effects || this.context?.state !== 'running' || document.hidden) return;
    const sound = terrain === 'swamp' ? [370, .20, .19, 155] :
      terrain === 'forest' ? [2600, .12, .15, 210] :
      terrain === 'spring' ? [1500, .16, .12, 340] : [1000, .095, .13, 160];
    const [frequency, duration, gain, thud] = sound;
    const context = this.context;
    const buffer = context.createBuffer(1, Math.ceil(duration * context.sampleRate), context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      const position = i / samples.length;
      samples[i] = (Math.random() * 2 - 1) * Math.min(1, position * 36) * (1 - position) ** 3;
    }
    const source = context.createBufferSource(); source.buffer = buffer;
    const filter = context.createBiquadFilter(); filter.type = 'bandpass'; filter.frequency.value = frequency; filter.Q.value = .62;
    const envelope = context.createGain(); envelope.gain.value = gain;
    source.connect(filter); filter.connect(envelope); envelope.connect(this.master);
    source.onended = () => { source.disconnect(); filter.disconnect(); envelope.disconnect(); };
    source.start();
    this.tone(thud, context.currentTime, duration * .72, .065, 'triangle');
  }
  play(kind) {
    if (!this.enabled || !this.effects || !this.context || this.context.state !== 'running' || document.hidden) return;
    const patterns = { pet:[660,880,1047], shy:[440,330], food:[1047,1568,1175], nibble:[380,320],
      sleep:[523,392,262], ball:[260,390,520], paw:[140], chest:[523,659,784], spring:[392,523,659], item:[440,660], guide:[440,554],
      delivery:[523,659,784,1047], success:[523,659,784,1047,1319], failure:[392,330,262], pause:[330] };
    const footstep = ['paw','nibble'].includes(kind);
    (patterns[kind] || patterns.guide).forEach((f, i) => this.tone(f, this.context.currentTime + i * .1,
      footstep ? .07 : kind === 'sleep' ? .8 : .35,
      footstep ? .045 : .16, footstep || kind === 'ball' ? 'triangle' : 'sine'));
  }
};
