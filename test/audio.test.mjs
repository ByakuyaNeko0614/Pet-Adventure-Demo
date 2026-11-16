import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source = readFileSync(new URL('../web/audio.js', import.meta.url), 'utf8');

function fixture() {
  const storage = new Map();
  const listeners = {};
  const document = {hidden:false, body:{append(){}}, addEventListener:(key, fn) => { listeners[key] = fn; }};
  let allow = false;
  const gain = () => ({value:0, setTargetAtTime(){}, setValueAtTime(){}, linearRampToValueAtTime(){}, exponentialRampToValueAtTime(){}});
  const route = () => ({connect(){}, disconnect(){}});
  class Audio {
    constructor(src) { this.src = src; this.paused = true; }
    addEventListener() {}
    async play() { if (!allow) throw new Error('NotAllowedError'); this.paused = false; }
    pause() { this.paused = true; }
  }
  class Context {
    constructor() { Object.assign(this, {currentTime:0, state:'suspended', destination:{}, starts:0, sampleRate:16000, frequencies:[]}); }
    async resume() { this.state = 'running'; }
    async suspend() { this.state = 'suspended'; }
    createGain() { return {...route(), gain:gain()}; }
    createOscillator() { return {...route(), frequency:{}, start:() => this.starts++, stop(){}}; }
    createBuffer(_, size) { return {getChannelData:() => new Float32Array(size)}; }
    createBufferSource() { return {...route(), start:() => this.starts++}; }
    createBiquadFilter() { const filter = {...route(), frequency:{}, Q:{}}; this.frequencies.push(filter.frequency); return filter; }
  }
  const GameSound = vm.runInNewContext(source + '\nGameSound', {window:{AudioContext:Context}, Audio, document,
    localStorage:{getItem:key => storage.get(key), setItem:(key,value) => storage.set(key,value)}});
  return {GameSound, document, listeners, allowPlayback:() => {allow = true;}};
}

test('音樂預設開啟，自動播放被擋後可在首次互動重試，靜音會記住', async () => {
  const {GameSound, listeners, allowPlayback} = fixture();
  const sound = new GameSound();
  assert.equal(sound.enabled, true);
  sound.start(() => {}, {contains:() => false});
  await sound.syncMusic();
  assert.equal(sound.waiting, true);
  assert.equal(sound.context, null);
  allowPlayback();
  listeners.keydown({});
  assert.equal(sound.track.paused, false);
  assert.equal(sound.context.state, 'running');
  sound.disable();
  assert.equal(sound.track.paused, true);
  assert.equal(new GameSound().enabled, false);
});

test('小屋和迷宮的原生循環配樂在隱藏分頁仍播放，音樂和音效分開控制', async () => {
  const {GameSound, document, allowPlayback} = fixture();
  allowPlayback();
  const home = new GameSound({theme:'home'});
  const adventure = new GameSound();
  assert.match(home.track.src, /home-theme\.mp3$/);
  assert.match(adventure.track.src, /forest-theme\.mp3$/);
  document.hidden = true;
  for (const sound of [home, adventure]) {
    await sound.enable();
    assert.equal(sound.track.loop, true);
    assert.equal(sound.track.paused, false);
  }
  document.hidden = false;
  home.configure(false, true, .4);
  assert.equal(home.track.paused, true);
  home.play('pet');
  assert.equal(home.context.starts, 3);
  home.configure(true, false, .6);
  home.play('pet');
  assert.equal(home.context.starts, 3);
  assert.equal(home.track.paused, false);
  const restored = new GameSound();
  assert.equal(restored.volume, .6);
  assert.equal(restored.effects, false);
});

test('探險腳步因地形改變，關閉音效或切到背景時不發聲', async () => {
  const {GameSound, document, allowPlayback} = fixture();
  allowPlayback();
  const sound = new GameSound();
  await sound.enable();
  for (const terrain of ['ground', 'swamp', 'forest', 'spring']) sound.footstep(terrain);
  assert.equal(sound.context.starts, 8);
  assert.equal(new Set(sound.context.frequencies.map(({value}) => value)).size, 4);
  document.hidden = true;
  sound.footstep('ground');
  document.hidden = false;
  sound.configure(true, false, .3);
  sound.footstep('ground');
  assert.equal(sound.context.starts, 8);
});

test('切換房間會更換配樂，同房間重新整理資料不會重播，靜音仍有效', async () => {
  const {GameSound, allowPlayback} = fixture();
  allowPlayback();
  const sound = new GameSound({theme:'home'});
  await sound.enable();
  sound.setRoom('conservatory');
  assert.match(sound.track.src,/conservatory-theme\.mp3$/);
  sound.track.currentTime=12;
  sound.setRoom('conservatory');
  assert.equal(sound.track.currentTime,12);
  sound.disable();
  sound.setRoom('loft');
  assert.match(sound.track.src,/loft-theme\.mp3$/);
  assert.equal(sound.track.paused,true);
});
