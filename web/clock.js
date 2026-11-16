'use strict';

var StepClock = class {
  constructor(step, timers = globalThis) {
    this.step = step;
    this.timers = timers;
    this.delay = 1200;
    this.running = false;
    this.timer = null;
    this.generation = 0;
  }

  schedule() {
    const generation = this.generation;
    this.timer = this.timers.setTimeout(() => {
      if (!this.running || generation !== this.generation) return;
      this.timer = null;
      try {
        this.step();
      } catch (error) {
        this.pause();
        throw error;
      }
      if (this.running && generation === this.generation) this.schedule();
    }, this.delay);
  }

  resume() {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }

  pause() {
    this.running = false;
    this.generation++;
    this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  setDelay(delay) {
    const running = this.running;
    this.pause();
    this.delay = delay;
    if (running) this.resume();
  }
};
