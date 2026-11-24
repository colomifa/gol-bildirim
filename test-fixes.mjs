import assert from 'node:assert/strict';
import { scoreGoalContext, eventContext, trainingVector, canSendGoalAlert } from './goal-model.mjs';
const baseMatch={home:'Home',away:'Away',homeId:1,awayId:2,homeGoals:0,awayGoals:0,minute:65};
const noData=scoreGoalContext(baseMatch,{preOdds:{home:1.35,draw:4.5,away:8}},{events:[],hist:[],currentRows:{}});
assert.equal(noData.nextGoal.side,null,'no live data must not select a side');
assert.equal(noData.nextGoal.label,'Belirsiz');
const balanced=scoreGoalContext(baseMatch,{preOdds:{home:2.50,draw:3.2,away:2.52}},{events:[],hist:[],currentRows:{}});
assert.equal(balanced.features.favoriteSide,null,'2.50 vs 2.52 must not declare a favorite');
const readyWindow={ready:true,score:70,metrics:{inside:{home:3,away:0},sot:{home:2,away:0},xg:{home:.5,away:.02},shots:{home:5,away:1},outside:{home:1,away:1},fouls:{home:1,away:2}}};
const withData=scoreGoalContext(baseMatch,{preOdds:{home:1.5,draw:4,away:6}},{w10:readyWindow,events:[],hist:[],currentRows:{}});
assert.equal(withData.nextGoal.side,'home','sufficient asymmetric live evidence should select home');
assert.ok(withData.nextGoal.dataReady);
assert.equal(trainingVector(withData).length,32,'V6 training vector schema remains stable');
assert.equal(canSendGoalAlert('2H',81),true,'81st minute remains eligible');
assert.equal(canSendGoalAlert('2H',82),false,'82nd minute is blocked');
assert.equal(canSendGoalAlert('2H',90),false,'90th minute is blocked');
assert.equal(canSendGoalAlert('2H',95),false,'stoppage time is blocked');
assert.equal(canSendGoalAlert('FT',90),false,'finished match is blocked');
assert.equal(canSendGoalAlert('HT',45),false,'halftime is blocked');
const events=[
 {time:{elapsed:50},team:{id:1},type:'Goal',detail:'Normal Goal'},
 {time:{elapsed:60},team:{id:1},type:'subst',detail:'Substitution',player:{name:'A'},assist:{name:'B'}},
 {time:{elapsed:70},team:{id:2},type:'Goal',detail:'Normal Goal'},
 {time:{elapsed:75},team:{id:2},type:'Goal',detail:'Normal Goal'},
];
const ctx=eventContext(events,{homeId:1,awayId:2,homeGoals:1,awayGoals:2});
assert.equal(ctx.trailingSub.home,0,'home substitution while leading must not be counted as trailing just because current score later changed');
assert.equal(ctx.substitutions[0].scoreAt.home,1);
assert.equal(ctx.substitutions[0].scoreAt.away,0);
console.log('V6 regression tests passed: no-data side, favorite margin, live side evidence, substitution-time score, 81-minute alert cutoff, vector schema');
