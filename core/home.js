'use strict';

var HomeLife = (() => {
  const layouts = {
    cottage: {sleep:[16,68], bowl:[81.5,62.5], toy:[62.7,84.5], rest:[42,74]},
    conservatory: {sleep:[20.8,64.5], bowl:[75.9,68.3], toy:[59,85], rest:[42,74]},
    loft: {sleep:[15.8,66], bowl:[84.5,66.9], toy:[62,84], rest:[44,75]}
  };
  const layout = room => layouts[room] || layouts.cottage;
  const spriteWidth = 13;
  const widthFor = count => Math.max(8.8, spriteWidth - Math.max(0, count - 2) * .85);
  const spriteFoot = .95;
  // The painted bowl and the mouths in the eating column, in image coordinates.
  const mouths = { fox: [.81, .93], cat: [.68, .92], rabbit: [.70, .92], dragon: [.72, .91] };
  function mealPoint(species, scene, width) {
    const [mouthX, mouthY] = mouths[species] || mouths.fox;
    return [scene.bowl[0] - (mouthX - .5) * width,
      scene.bowl[1] - (mouthY - spriteFoot) * width * 4 / 3];
  }
  const labels = { sleep: '窩裡睡一下…', eat: '飯飯聞起來好香！', play: '來追球！', rest: '先安靜待一下。', wander: '這邊有什麼呢？', love: '喜歡你的摸摸 ♥', flee: '等一下，我想自己待著。', away: '正在外面冒險。' };
  function createBall(room) {
    const [x, y] = layout(room).toy;
    return {x,y,spin:0,hits:0,playerId:null,to:null};
  }
  function create(pet, saved) {
    const random = Rules.seeded('home', pet.id);
    return { x: 24 + random() * 43, y: 75 + random() * 12, hunger: 25 + random() * 45,
      energy: 45 + random() * 40, social: 60, state: 'wander', target: [30 + random()*37, 77],
      held: 0, touches: 0, sinceTouch: 30, facing: 1, moving: false, speed: 0,
      ...(saved && Number.isFinite(saved.hunger) ? { hunger: Rules.clamp(saved.hunger,0,100), energy: Rules.clamp(saved.energy,0,100), social: Rules.clamp(saved.social ?? 60,0,100) } : {}) };
  }
  /*
   * 小屋的行為依需求排列優先順序。開始睡覺或吃飯後，有各自的結束門檻，
   * 以免數值剛好貼近起始門檻時，每一幀都在兩種行為之間切換。
   */
  function choose(life, condition, pet) {
    if (pet.away) return 'away';
    if (life.state === 'sleep' && (life.energy < 85 || life.held > 0)) return 'sleep';
    if (life.energy < 24 || condition.stamina / pet.maxStamina < .3) return 'sleep';
    if ((life.state === 'eat' && (life.moving || life.held > 0 || life.hunger > 12)) || life.hunger > 68) return 'eat';
    if (life.held > 0) return life.state;
    if (condition.courage / pet.maxCourage < .3 || condition.patience / pet.patience < .25) return 'rest';
    if (life.invite) return life.invite;
    return 'wander';
  }
  function rollBall(ball, life, random) {
    const direction = ball.x < 34 ? 1 : ball.x > 64 ? -1 : ball.x < life.x ? -1 : 1;
    ball.to = [Rules.clamp(ball.x + direction * (13 + 10 * random()), 21, 74), 74 + random() * 12];
  }
  function moveBall(life, dt, random, width) {
    const ball = life.ball;
    const dx = ball.to[0] - ball.x, dy = ball.to[1] - ball.y;
    const distance = Math.hypot(dx, dy);
    if (distance > .05) {
      const travel = Math.min(distance, Math.max(6, Math.min(26, distance * 3)) * dt);
      ball.x += dx / distance * travel; ball.y += dy / distance * travel;
      ball.spin += Math.sign(dx || 1) * travel * 33;
    }
    // 球停下、寵物也靠近到可觸碰的範圍後，才算拍中並決定下一次滾動。
    const reach = width * .34;
    const facing = ball.x < life.x ? -1 : 1;
    life.target = [ball.x - facing * reach * .7, ball.y + .55];
    if (distance <= 1 && Math.hypot(ball.x - life.x, (ball.y - life.y) * .75) < reach + 1 && life.ballTap <= 0) {
      life.facing = facing;
      life.ballTap = .28;
      ball.hits++;
      rollBall(ball, life, random);
    }
  }
  function set(life, state, random, pet = {}, width = spriteWidth, roomBall = null) {
    if (life.state === state && state !== 'wander') return;
    life.state = state;
    const scene = layout(pet.room);
    if (state !== 'play') {
      if (life.ball && life.ball.playerId === pet.id) { life.ball.playerId = null; life.ball.to = null; }
      life.ball = null; life.ballTap = 0;
    }
    if (state === 'eat') life.target = mealPoint(pet.species, scene, width);
    else if (state === 'play') {
      life.ball = roomBall || createBall(pet.room);
      life.ball.playerId = pet.id;
      life.ballTap = 0;
      rollBall(life.ball, life, random);
    }
    else if (scene[state]) life.target = [...scene[state]];
    else life.target = [24 + random() * 43, 75 + random() * 12];
    life.held = { wander: 2 + random() * 3, play: 12, sleep: 30, eat: 4 }[state] || 0;
  }
  function touch(life, pet, random = Math.random) {
    if (pet.away) return 'away';
    if (life.state === 'sleep' || life.state === 'eat') return life.state;
    life.touches = life.sinceTouch < 5 ? life.touches + 1 : 1;
    life.sinceTouch = 0;
    const flee = life.touches >= 3 || random() < (pet.personality === 'timid' ? .45 : .12);
    set(life, flee ? 'flee' : 'love', random, pet);
    if (!flee) life.target = [life.x, life.y];
    life.held = flee ? 5 : 3;
    life.social = Rules.clamp(life.social + (flee ? -5 : 8), 0, 100);
    return life.state;
  }
  function tick(life, pet, condition, dt, random = Math.random, width = spriteWidth, roomBall = null) {
    dt = Math.min(1, Math.max(0, dt));
    life.sinceTouch += dt;
    if (!life.moving || life.state === 'play') life.held = Math.max(0, life.held - dt);
    const next = choose(life, condition, pet);
    if (next !== life.state || (next === 'wander' && !life.held && !life.moving)) {
      set(life, next, random, pet, width, roomBall);
    }
    if (next === 'away') { life.moving = false; life.speed = 0; return; }
    if (life.invite === next) life.invite = null;
    if (next === 'eat') life.target = mealPoint(pet.species, layout(pet.room), width);
    if (next === 'play' && life.ball.playerId === pet.id) {
      life.ballTap = Math.max(0, life.ballTap - dt);
      moveBall(life, dt, random, width);
    }
    const dx = life.target[0] - life.x;
    const dy = life.target[1] - life.y;
    const distance = Math.hypot(dx, dy * .75);
    const maxSpeed = next === 'flee' ? 21 : next === 'play' ? 19 : 12;
    life.speed = Math.min(maxSpeed, life.speed + 36 * dt, Math.sqrt(72 * distance));
    const travel = life.speed * dt;
    life.moving = distance > Math.max(.12, travel);
    if (life.moving) {
      life.x += dx * travel / distance;
      life.y += dy * travel / distance;
      if (Math.abs(dx) > 1) life.facing = dx < 0 ? -1 : 1;
    } else {
      [life.x, life.y] = life.target;
      life.speed = 0;
      if (next === 'eat') life.facing = 1;
    }
    const stationaryTime = Math.max(0, dt - (travel > 0 ? distance / travel * dt : 0));
    life.hunger = Rules.clamp(life.hunger + (next === 'eat' ? -8 * stationaryTime : .13 * dt), 0, 100);
    life.energy = Rules.clamp(life.energy + (next === 'sleep' ? 3 * stationaryTime : -.09 * dt), 0, 100);
  }
  return { create, createBall, choose, touch, tick, labels, layout, widthFor, spriteWidth, spriteFoot };
})();
