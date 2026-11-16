import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source = ['rules','maze','decision','adventure','store','home'].map(n=>readFileSync(new URL(`../core/${n}.js`,import.meta.url),'utf8')).join('\n');
const {Rules,Adventure,Store,HomeLife}=vm.runInNewContext(source+';({Rules,Adventure,Store,HomeLife})');
const now='2026-11-09T00:00:00.000Z';let seq=0;
function send(data,op,input,time=now,id){return Store.mutate(data,{op,input,revision:data.revision,requestId:`request-test-${++seq}`},{id:id || `pet-test-${seq}`,time});}
function setup() {
  const data = Store.fresh();
  const start = new Date(Date.parse(now) - Rules.incubationSeconds(data.hatched) * 1000).toISOString();
  const egg = send(data, 'incubate', {}, start).value;
  send(data, 'hatch', {id: egg.id});
  return data;
}
test('小屋行為樹優先睡覺及吃飯，滿足後離開，連續摸摸會躲開',()=>{
 const pet=setup().pets[0],c=Rules.condition(pet,now),life=HomeLife.create(pet);
 life.energy=10;life.hunger=90;assert.equal(HomeLife.choose(life,c,pet),'sleep');
 life.state='sleep';life.energy=60;assert.equal(HomeLife.choose(life,c,pet),'sleep');
 life.energy=90;assert.equal(HomeLife.choose(life,c,pet),'eat');life.state='eat';life.hunger=8;assert.equal(HomeLife.choose(life,c,pet),'wander');
 assert.equal(HomeLife.touch(life,pet,()=>.99),'eat');
 HomeLife.tick(life,pet,c,.1,()=>.5);
 assert.equal(HomeLife.touch(life,pet,()=>.99),'love');HomeLife.touch(life,pet,()=>.99);assert.equal(HomeLife.touch(life,pet,()=>.99),'flee');
 life.state='sleep';assert.equal(HomeLife.touch(life,pet),'sleep');
});
test('從碗的右側接近時先向左走，抵達後轉向飯碗才吃', () => {
  const pet = {...setup().pets[0], species: 'fox'};
  const condition = Rules.condition(pet, now);
  const life = HomeLife.create(pet);
  Object.assign(life, {x: 88, y: 76, hunger: 45, energy: 80, invite: 'eat'});
  HomeLife.tick(life, pet, condition, .1);
  assert.equal(life.state, 'eat');
  assert.equal(life.moving, true);
  assert.equal(life.facing, -1);
  assert.equal(life.hunger, 45);
  for (let i = 0; i < 100 && life.moving; i++) HomeLife.tick(life, pet, condition, .1);
  assert.equal(life.moving, false);
  assert.equal(life.facing, 1);
  assert.deepEqual([life.x, life.y], [...life.target]);
  HomeLife.tick(life, pet, condition, .1);
  assert.ok(life.hunger < 45);
});
test('寵物先走到食盆再進食，低需求不在兩個狀態間跳動',()=>{
 const pet=setup().pets[0],c=Rules.condition(pet,now),life=HomeLife.create(pet);life.hunger=90;life.energy=80;life.x=15;life.y=50;
 HomeLife.tick(life,pet,c,1,()=>.5);assert.equal(life.state,'eat');assert.ok(life.hunger>=90);
 for(let i=0;i<24;i++)HomeLife.tick(life,pet,c,1,()=>.5);
 assert.ok(life.hunger<20);assert.notEqual(life.state,'eat');
});

test('房間預設為暖陽小屋，付費解鎖才可搬家，重載後保留住處',()=>{
  const data=setup(), pet=data.pets[0];
  assert.equal(Store.view(data).pets[0].room,'cottage');
  assert.throws(()=>send(data,'movePet',{petId:pet.id,roomId:'conservatory'}),/先解鎖/);
  assert.throws(()=>send(data,'unlockRoom',{roomId:'conservatory'}),/金幣不足/);
  data.coins=Rules.rooms.conservatory.price+20;
  send(data,'unlockRoom',{roomId:'conservatory'});
  assert.equal(data.coins,20);
  assert.throws(()=>send(data,'unlockRoom',{roomId:'conservatory'}),/已解鎖/);
  send(data,'movePet',{petId:pet.id,roomId:'conservatory'});
  const restored=Store.view(JSON.parse(JSON.stringify(data)));
  assert.equal(restored.pets[0].room,'conservatory');
  assert.deepEqual([...restored.rooms],['cottage','conservatory']);
  send(data,'begin',{petId:pet.id,difficulty:'easy'});
  assert.throws(()=>send(data,'movePet',{petId:pet.id,roomId:'cottage'}),/探險回來/);
});

test('一間房只有一顆實體球，牠會追過去、把球拍走，玩完球仍留在原地',()=>{
  const pet={...setup().pets[0],room:'conservatory'};
  const c=Rules.condition(pet,now), life=HomeLife.create(pet), ball=HomeLife.createBall(pet.room);
  Object.assign(life,{x:40,y:80,hunger:10,energy:80,invite:'play'});
  const initial=[ball.x,ball.y];
  for(let i=0;i<100;i++) HomeLife.tick(life,pet,c,.1,()=>.5,13,ball);
  assert.equal(life.state,'play');
  assert.equal(life.ball,ball);
  assert.ok(ball.hits >= 1);
  assert.notDeepEqual([ball.x,ball.y],initial);
  const hits=ball.hits;
  for(let i=0;i<60;i++) HomeLife.tick(life,pet,c,.1,()=>.5,13,ball);
  assert.notEqual(life.state,'play');
  assert.equal(ball.playerId,null);
  assert.ok(ball.hits>=hits);
  assert.notDeepEqual([ball.x,ball.y],initial);
});
test('每步進度保存消耗、拒絕回退；放棄也保留消耗，再出發不補滿',()=>{
 const data=setup(),pet=data.pets[0],ticket=send(data,'begin',{petId:pet.id,difficulty:'easy'}).value;
 const state=Adventure.create(ticket);Adventure.execute(state,Adventure.prepare(state));
 send(data,'progress',{id:ticket.id,actions:state.actions});
 assert.equal(pet.condition.stamina,state.stamina);assert.equal(pet.condition.patience,pet.patience-.25);
 assert.throws(()=>send(data,'progress',{id:ticket.id,actions:[]}),/較新的進度/);
 assert.throws(()=>send(data,'begin',{petId:pet.id,difficulty:'easy'}),/先完成/);
 const copy=JSON.parse(JSON.stringify(data));assert.equal(Adventure.replay(copy.active,copy.active.progress).stamina,state.stamina);
 send(data,'abandon',{id:ticket.id});
 const next=send(data,'begin',{petId:pet.id,difficulty:'easy'}).value;
 assert.equal(Adventure.create(next).stamina,state.stamina);
});
test('恢復按真實時間計算，離線有效，探索中凍結且不超過上限',()=>{
 const pet=setup().pets[0];pet.condition={stamina:1,courage:2,patience:3,at:now};
 const time='2026-11-09T00:02:00.000Z';const recovered=Rules.condition(pet,time);
 assert.equal(recovered.stamina,5);assert.equal(recovered.courage,4);assert.equal(recovered.patience,5);
 assert.equal(Rules.condition(pet,time,true).stamina,1);
 assert.equal(Rules.condition(pet,'2026-11-10T00:00:00Z').stamina,pet.maxStamina);
});
test('補給恢復目前值，能力果只加上限；出門期間禁止在家補給',()=>{
 const data=setup(),pet=data.pets[0];pet.condition={stamina:1,courage:2,patience:3,at:now};
 send(data,'care',{petId:pet.id,itemId:'tonic'});assert.equal(pet.condition.stamina,17);assert.equal(data.inventory.tonic,undefined);
 data.inventory.staminaSeed=1;const cap=pet.maxStamina;
 pet.iv.stamina=24;
 const {chance}=Rules.trainingOdds(pet,Rules.items.staminaSeed);
 let roll=0;
 while(Rules.seeded('training','roll-'+roll,pet.id,'staminaSeed')()*100>=chance)roll++;
 assert.equal(send(data,'care',{petId:pet.id,itemId:'staminaSeed'},now,'roll-'+roll).value.success,true);
 assert.equal(pet.iv.stamina,25);
 assert.equal(pet.maxStamina,cap+4);assert.equal(pet.condition.stamina,17);
 send(data,'begin',{petId:pet.id,difficulty:'easy'});assert.throws(()=>send(data,'care',{petId:pet.id,itemId:'tea'}),/探索中/);
});
