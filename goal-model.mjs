const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(Number(n)) ? Number(n) : lo));
const num = (v) => v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
const pct = (v) => { const n = num(String(v ?? "").replace("%", "")); return n === null ? null : n > 1 ? n : n * 100; };
const avg = (a, b) => a == null && b == null ? null : a == null ? b : b == null ? a : (a + b) / 2;
const formScore = (form) => { if (!form) return null; const chars = String(form).toUpperCase().replace(/[^WDL]/g, "").slice(-5).split(""); return chars.length ? chars.reduce((s,c)=>s+(c==="W"?3:c==="D"?1:0),0)/(chars.length*3)*100 : null; };
function teamSummary(raw, venue) {
  if (!raw) return null;
  const f=raw.fixtures||{},g=raw.goals||{},played=num(f.played?.[venue]),scored=num(g.for?.average?.[venue]),conceded=num(g.against?.average?.[venue]);
  const winRaw=f.wins?.[venue]?.percentage??f.wins?.[venue]?.percent,winCount=num(f.wins?.[venue]);
  const lossRaw=f.loses?.[venue]?.percentage??f.loses?.[venue]?.percent,lossCount=num(f.loses?.[venue]);
  return {played,scored,conceded,winPct:winRaw!=null?pct(winRaw):played&&winCount!=null?winCount/played*100:null,lossPct:lossRaw!=null?pct(lossRaw):played&&lossCount!=null?lossCount/played*100:null,lateConceded:minuteBucket(g.against?.minute)};
}
function minuteBucket(obj) {
  if (!obj || typeof obj !== "object") return null;
  const keys=Object.keys(obj); const key=keys.find(k=>/^76\s*[-–]\s*90/.test(k)) || keys.find(k=>/^75\s*[-–]/.test(k));
  const v=key?obj[key]:null; return num(v?.total) ?? num(v?.percentage) ?? null;
}
function impliedOdds(odds) { if(!odds)return null; const o=num(odds.over25),u=num(odds.under25); if(o==null||u==null||o<=1||u<=1)return null; const po=1/o,pu=1/u; return po/(po+pu); }
const tableTeam=(rows,id)=>Array.isArray(rows)?rows.find(r=>String(r.team?.id)===String(id))||null:null;
const metric=(w,k,side)=>num(w?.metrics?.[k]?.[side]);
function eventContext(events, match) {
  const red={home:0,away:0}, subs={home:0,away:0}, trailingSub={home:0,away:0}, lastSubMinute={home:null,away:null};
  for(const e of events||[]) {
    const side=e.team?.id===match.homeId?"home":e.team?.id===match.awayId?"away":null; if(!side)continue;
    const type=String(e.type||"").toLowerCase(), detail=String(e.detail||"").toLowerCase(), minute=num(e.time?.elapsed)||0;
    if(type==="card" && /red card|second yellow|second yellow card/.test(detail)) red[side]++;
    if(type==="subst" || /substitution/.test(detail)) {
      subs[side]++; lastSubMinute[side]=Math.max(lastSubMinute[side]??0,minute);
      const h=num(match.homeGoals)||0,a=num(match.awayGoals)||0;
      const trailing=side==="home"?h<a:a<h;
      if(trailing && minute>=60) trailingSub[side]++;
    }
  }
  const trailingSide=(num(match.homeGoals)||0)<(num(match.awayGoals)||0)?"home":(num(match.awayGoals)||0)<(num(match.homeGoals)||0)?"away":null;
  return {red,subs,trailingSub,lastSubMinute,trailingSide};
}
function rowStat(rows, names) {
  for (const name of names) { const r=(rows||[]).find(v=>String(v.type).toLowerCase()===name.toLowerCase()); const n=num(r?.value); if(n!=null)return n; }
  return null;
}
function pressureAfterSub(live, side, subMinute) {
  if (!side || subMinute == null || !live.currentRows) return null;
  const base=[...(live.hist||[])].reverse().find(h=>Number(h.minute)<=Number(subMinute));
  if(!base?.rows)return null;
  const cur=live.currentRows[side]||[],old=base.rows[side]||[];
  const delta=(names)=>{const a=rowStat(cur,names),b=rowStat(old,names);return a==null||b==null?null:Math.max(0,a-b);};
  const inside=delta(["Shots insidebox","Shots Inside Box"]),sot=delta(["Shots on Goal","Shots on Target"]),shots=delta(["Total Shots","Total shots"]);
  const values=[]; if(inside!=null)values.push(Math.min(1,inside/3)*50); if(sot!=null)values.push(Math.min(1,sot/2)*35); if(shots!=null)values.push(Math.min(1,shots/5)*15);
  return values.length?Math.round(values.reduce((a,b)=>a+b,0)):null;
}
export function scoreGoalContext(match, context={}, live={}) {
  const w10=live.w10?.ready?live.w10:null,w15=live.w15?.ready?live.w15:null;
  const liveScore=w10?.score==null&&w15?.score==null?null:Math.max(w10?.score??0,w15?.score??0);
  const overProb=impliedOdds(context.preOdds),odds=context.preOdds||{};
  const oddsVals=[num(odds.home),num(odds.draw),num(odds.away)].filter(v=>v!=null&&v>1);
  const implied=oddsVals.length===3?oddsVals.map(v=>1/v):null,sum=implied?.reduce((a,b)=>a+b,0)||0;
  const drawProb=sum?implied[1]/sum:null;
  const marketSignals=[]; if(overProb!=null)marketSignals.push({v:overProb*100,w:.75}); if(drawProb!=null)marketSignals.push({v:(1-drawProb)*100,w:.25});
  const oddsScore=marketSignals.length?clamp(marketSignals.reduce((a,b)=>a+b.v*b.w,0)/marketSignals.reduce((a,b)=>a+b.w,0)):null;
  const home=teamSummary(context.homeStats,"home"),away=teamSummary(context.awayStats,"away");
  const expectedHome=home?.scored==null||away?.conceded==null?null:(home.scored+away.conceded)/2;
  const expectedAway=away?.scored==null||home?.conceded==null?null:(away.scored+home.conceded)/2;
  const expectedGoals=expectedHome==null&&expectedAway==null?null:(expectedHome||0)+(expectedAway||0);
  const venueScore=expectedGoals==null?null:clamp(expectedGoals/3.5*100);
  const ht=tableTeam(context.standings,match.homeId),at=tableTeam(context.standings,match.awayId),tableSize=context.standings?.length||0;
  const form=avg(formScore(ht?.form),formScore(at?.form)),win=avg(home?.winPct,away?.winPct);
  const rank=tableSize>1&&ht&&at?avg((1-((num(ht.rank)||tableSize)-1)/(tableSize-1))*100,(1-((num(at.rank)||tableSize)-1)/(tableSize-1))*100):null;
  const formVals=[form,win,rank].filter(v=>v!=null),formScoreValue=formVals.length?clamp(formVals.reduce((a,b)=>a+b,0)/formVals.length):null;
  const minute=num(match.minute)||0,totalGoals=(num(match.homeGoals)||0)+(num(match.awayGoals)||0);
  const events=eventContext(live.events,match), redDiff=events.red.away-events.red.home;
  const scoreDiff=(num(match.homeGoals)||0)-(num(match.awayGoals)||0);
  const trailingSide=scoreDiff<0?"home":scoreDiff>0?"away":null;
  const trailingSubCount=trailingSide?events.trailingSub[trailingSide]:0;
  const subMinute=trailingSide?events.lastSubMinute[trailingSide]:null;
  const postSubPressure=trailingSide&&trailingSubCount>0?pressureAfterSub(live,trailingSide,subMinute):null;
  const m10=w10?.metrics||{};
  const inside=metric(w10,"inside","total"),outside=metric(w10,"outside","total"),shots=metric(w10,"shots","total"),fouls=metric(w10,"fouls","total");
  const insideRatio=inside!=null&&outside!=null&&inside+outside>0?inside/(inside+outside):null;
  const outsidePenalty=insideRatio==null?0:clamp((.45-insideRatio)/.45*12,0,12);
  const foulPenalty=fouls==null?0:clamp(Math.max(0,fouls-4)*1.5,0,10)*(shots!=null&&shots>=3?0.45:1);
  const tempoScore=insideRatio==null&&fouls==null?null:clamp(75+(insideRatio==null?0:(insideRatio-.25)*45)-foulPenalty-outsidePenalty);
  const redScore=events.red.home+events.red.away===0?50:clamp(50+redDiff*22);
  const subScore=trailingSubCount===0?50:clamp(60+Math.min(2,trailingSubCount)*10+(postSubPressure!=null&&postSubPressure>=55?15:0));
  const lateConcede=avg(home?.lateConceded,away?.lateConceded);
  const lateScore=lateConcede==null?null:clamp(lateConcede>1?80:lateConcede>0?65:35);
  const minuteScore=minute>=20&&minute<=78?85:minute>=10&&minute<=85?65:40;
  // Skorun maçın beklenen gol seviyesini aşması, kalan bölümde ek gol sinyalini azaltır.
  // Bu ceza mutlak değildir: canlı baskı ve savunma zaafı yüksekse diğer bileşenler sinyali koruyabilir.
  const elapsedShare=clamp(minute/90,0,1);
  const expectedByMinute=expectedGoals==null?null:expectedGoals*elapsedShare;
  const goalSurplus=expectedByMinute==null?null:Math.max(0,totalGoals-expectedByMinute);
  const scoreSurplusPenalty=goalSurplus==null?0:clamp(goalSurplus*8 + Math.max(0,totalGoals-3)*4,0,32);
  const scoreState=clamp(82-scoreSurplusPenalty);
  const homeOdds=num(odds.home),awayOdds=num(odds.away);
  const favoriteSide=homeOdds!=null&&awayOdds!=null?(homeOdds<awayOdds?"home":awayOdds<homeOdds?"away":null):null;
  const favoriteTrailing= favoriteSide && ((favoriteSide==="home" && scoreDiff<0)||(favoriteSide==="away" && scoreDiff>0));
  const favoriteLeadingByTwo= favoriteSide && ((favoriteSide==="home" && scoreDiff>=2)||(favoriteSide==="away" && scoreDiff<=-2));
  const trailingFavoriteBoost=favoriteTrailing?18:0;
  const leadingFavoritePenalty=favoriteLeadingByTwo?12:0;
  const gameScore=clamp(minuteScore*.45+scoreState*.45+(events.red.home+events.red.away?5:0)+trailingFavoriteBoost-leadingFavoritePenalty);
  const parts=[
    {key:"live",label:"Canlı hücum baskısı",value:liveScore,weight:30},
    {key:"odds",label:"Maç önü oranları",value:oddsScore,weight:15},
    {key:"venue",label:"İç saha / deplasman",value:venueScore,weight:10},
    {key:"form",label:"Puan durumu ve form",value:formScoreValue,weight:10},
    {key:"tempo",label:"Tempo / şut kalitesi",value:tempoScore,weight:10},
    {key:"discipline",label:"Kırmızı kart etkisi",value:events.red.home+events.red.away?redScore:50,weight:5},
    {key:"subs",label:"Gerideyken 60+ değişiklik",value:trailingSubCount?subScore:50,weight:5},
    {key:"late",label:"Son 15 dk gol yeme eğilimi",value:lateScore,weight:10},
    {key:"game",label:"Dakika ve skor durumu",value:gameScore,weight:5},
    {key:"scoreSurplus",label:"Skorun gol ortalamasını aşması",value:scoreState,weight:5},
  ];
  const available=parts.filter(p=>p.value!=null),weight=available.reduce((s,p)=>s+p.weight,0);
  let score=weight?Math.round(available.reduce((s,p)=>s+p.value*p.weight,0)/weight):null;
  const coverage=Math.round(weight),level=score==null?"Veri bekleniyor":score>=75?"Yüksek gol sinyali":score>=60?"Gol eğilimi":score>=40?"Orta":"Düşük";
  const signal=score!=null&&score>=75&&liveScore!=null&&liveScore>=55&&coverage>=60;
  return {ready:score!=null,score,level,signal,coverage,livePressure:liveScore,probability:null,probabilityLabel:"Model henüz kalibre edilmedi",expectedGoals:expectedGoals==null?null:+expectedGoals.toFixed(2),preOdds:context.preOdds||null,over25Probability:overProb==null?null:+overProb.toFixed(3),components:parts.map(p=>({...p,value:p.value==null?null:Math.round(p.value)})),features:{insideShots:inside,outsideShots:outside,insideRatio,outsideRatio:insideRatio==null?null:1-insideRatio,fouls,foulPenalty,outsidePenalty,redHome:events.red.home,redAway:events.red.away,trailingSide,trailingSubCount,postSubPressure,lateConceded:lateConcede,totalGoals,goalSurplus,scoreSurplusPenalty,favoriteSide,favoriteTrailing:!!favoriteTrailing,favoriteLeadingByTwo:!!favoriteLeadingByTwo,leadingFavoritePenalty,trailingFavoriteBoost},context:{homeRank:num(ht?.rank),awayRank:num(at?.rank),homePoints:num(ht?.points),awayPoints:num(at?.points),homeForm:ht?.form||null,awayForm:at?.form||null,homeScored:home?.scored??null,homeConceded:home?.conceded??null,awayScored:away?.scored??null,awayConceded:away?.conceded??null,homeLateConceded:home?.lateConceded??null,awayLateConceded:away?.lateConceded??null}};
}
export function trainingVector(p) {
  const f=p?.features||{};
  const vals=[(p?.livePressure??0)/100,p?.over25Probability??.5,(p?.expectedGoals??1.8)/4,(p?.components?.find(x=>x.key==="form")?.value??50)/100,(p?.components?.find(x=>x.key==="game")?.value??50)/100,(p?.coverage??0)/100,(f.insideShots??0)/6,(f.outsideRatio ?? (f.insideRatio == null ? 0.5 : 1 - f.insideRatio)),(f.fouls??0)/10,(f.lateConceded??0)/3,((f.redHome??0)-(f.redAway??0)+2)/4,(f.trailingSubCount??0)/2,(f.postSubPressure??0)/100,(f.totalGoals??0)/7,(f.goalSurplus??0)/4,(f.scoreSurplusPenalty??0)/32,(f.favoriteTrailing?1:0),(f.favoriteLeadingByTwo?1:0)];
  return vals.map(v=>Math.max(0,Math.min(1,Number(v)||0)));
}
const sigmoid=z=>1/(1+Math.exp(-Math.max(-30,Math.min(30,z))));
export function trainLogistic(samples,oldWeights=null) {
  const valid=(samples||[]).filter(s=>Array.isArray(s.x)&&s.x.length>0&&(s.y===0||s.y===1));
  const dim=valid[0]?.x.length||0;if(!dim||valid.some(s=>s.x.length!==dim))return null;
  const positives=valid.filter(s=>s.y===1).length;if(valid.length<250||positives<25||valid.length-positives<50)return null;
  let w=Array.isArray(oldWeights)&&oldWeights.length===dim+1?[...oldWeights]:Array(dim+1).fill(0);if(!oldWeights||oldWeights.length!==dim+1)w[0]=-1.5;
  const lr=.035,lambda=.02;
  for(let epoch=0;epoch<700;epoch++){const grad=Array(dim+1).fill(0);for(const s of valid){const z=w[0]+s.x.reduce((sum,v,i)=>sum+w[i+1]*v,0),err=sigmoid(z)-s.y;grad[0]+=err;for(let i=0;i<dim;i++)grad[i+1]+=err*s.x[i];}for(let i=0;i<=dim;i++){grad[i]=grad[i]/valid.length+(i?lambda*w[i]:0);w[i]-=lr*grad[i];}}
  return {weights:w,samples:valid.length,positives,trainedAt:Date.now(),features:dim};
}
export function predictTrainedProbability(vector,weights){if(!Array.isArray(weights)||weights.length!==vector?.length+1)return null;return sigmoid(weights[0]+vector.reduce((sum,v,i)=>sum+v*weights[i+1],0));}
