// ══ helpers ══
function gps(lat,lng,kmh){onGPS({coords:{latitude:lat,longitude:lng,accuracy:8,altitude:30,speed:kmh/3.6,heading:0},timestamp:Date.now()});}
const realNow=Date.now.bind(Date); let fake=realNow(); Date.now=()=>fake;

// ══ TEST 1: math ══
console.assert(Math.abs(haversine(57.7089,11.9746,57.7189,11.9746)-1.112)<0.02,'haversine FAIL');
console.log('1. haversine OK');

// ══ TEST 2: maneuver peak detection (90° corner = ONE right turn) ══
routePts=[];
for(let i=0;i<=100;i++)routePts.push({lat:57.70+i*0.0001,lon:11.97});
for(let i=1;i<=100;i++)routePts.push({lat:57.71,lon:11.97+i*0.0002});
buildCumDist(routePts);totalRouteDist=routeCumDist[routeCumDist.length-1];
maneuvers=buildManeuvers(routePts);
const t2=maneuvers.filter(m=>m.type!=='arrive');
console.assert(t2.length===1&&t2[0].type==='right','maneuver FAIL: '+JSON.stringify(t2.map(x=>x.type)));
console.log('2. buildManeuvers OK:',maneuvers.map(m=>m.type).join(','));

// ══ TEST 3: MULTI-LAP CYCLE — 3 stops at the SAME physical location ══
// (this is the field bug: "completou todas as paradas na primeira parada")
const SL=57.71, SG=11.97; // stop location (the corner)
stops=[1,2,3].map(id=>({id,name:'Lap '+id,lat:SL,lng:SG,dur_s:10,elapsed:0,running:false,intervalId:null,state:'waiting'}));
stopMarkers={1:{setIcon(){}},2:{setIcon(){}},3:{setIcon(){}}};
const mk=()=>({addTo(){return this},setLatLngs(){},addLatLng(){},bringToFront(){},setIcon(){},setLatLng(){},getBounds:()=>({isValid:()=>true})});
routeLayer=routeAheadLayer=routeRemainLayer=routeDoneLayer=mk();
insideStop.clear();lastRouteIdx=0;navActive=true;departGate=null;

gps(SL,SG,3); // arrive slowly at the stop
console.assert(stops[0].state==='current','lap1 arrive FAIL: '+stops[0].state);
console.assert(stops[1].state==='waiting'&&stops[2].state==='waiting',
  'ALL-STOPS-AT-ONCE BUG STILL PRESENT: '+stops.map(s=>s.state).join(','));
console.log('3a. only lap-1 arrived OK:',stops.map(s=>s.state).join(','));

markDone(1); // timer auto-complete equivalent
gps(SL,SG,2); gps(SL,SG,1); // still parked at the stop
console.assert(stops[1].state==='waiting','GATE FAIL — lap2 arrived while still parked: '+stops[1].state);
console.log('3b. departure gate holds while parked OK');

gps(57.7135,SG,40); // drive away ~390 m, fast (clears gate)
gps(SL,SG,3);        // come back around the lap
console.assert(stops[1].state==='current','lap2 re-arrival FAIL: '+stops[1].state);
console.assert(stops[2].state==='waiting','lap3 premature FAIL');
console.log('3c. lap-2 armed after real departure OK');

// ══ TEST 4: regression — two DISTINCT stops, auto-stop departure ══
stops=[{id:1,name:'A',lat:57.70,lng:11.97,dur_s:10,elapsed:5,running:false,intervalId:null,state:'waiting'},
       {id:2,name:'B',lat:57.706,lng:11.97,dur_s:10,elapsed:0,running:false,intervalId:null,state:'waiting'}];
stopMarkers={1:{setIcon(){}},2:{setIcon(){}}};
insideStop.clear();departGate=null;
gps(57.70,11.97,3);                        // arrive A
console.assert(stops[0].state==='current','A arrive FAIL');
stops[0].running=true;                     // timer running (mock interval doesn't tick)
gps(57.7025,11.97,30);                     // depart A (~280m, fast)
console.assert(stops[0].state==='done','A auto-stop FAIL: '+stops[0].state);
gps(57.706,11.97,3);                       // arrive B (~670m from A — gate long cleared)
console.assert(stops[1].state==='current','B arrive FAIL: '+stops[1].state);
console.log('4. distinct sequential stops OK');

// ══ TEST 5: rotation branch executes (DOMMatrix present, no crash) ══
let svCalls=0; map.setView=()=>{svCalls++};
currentHeading=90; gps(57.706,11.97,30);
console.assert(svCalls>0,'follow/rotation branch FAIL — setView never called');
console.log('5. rotation/follow branch OK');

// ══ TEST 6: stopRec auto-loads the recording ══
navActive=false;isRec=true;
recPoints=[];for(let i=0;i<50;i++)recPoints.push({lat:57.70+i*0.0001,lng:11.97,t:fake+i*1000});
recStops=[{lat:57.702,lng:11.97,t:fake,dur_s:12,startT:fake,events:['openDoor'],photo:null}];
recStopCandidate=null;
stopRec();
console.assert(savedRecs.filter(Boolean).length>=1,'stopRec save FAIL');
console.assert(routePts.length===50,'AUTO-LOAD FAIL — route not loaded after rec: '+routePts.length);
console.assert(stops.length===1&&stops[0].events.includes('openDoor'),'auto-load stops/events FAIL');
console.assert(el('btn-nav').disabled===false,'Nav button not armed after auto-load');
console.log('6. stopRec auto-load OK — route, stops, events, Nav ready');

console.log('ALL TESTS PASSED');

// ══ TEST 7: settings persistence ══
el('rng-radius').value='12'; saveSettings();
el('rng-radius').value='80'; loadSettings();
console.assert(el('rng-radius').value==='12','settings persist FAIL: '+el('rng-radius').value);
console.log('7. settings persistence OK');

// ══ TEST 8: script-generated JSON import (lat/lon, ISO t, no dist, duracao_s) ══
const scriptJSON=JSON.stringify({points:[
  {lat:57.70,lon:11.97,t:'2026-06-10T08:00:00Z'},
  {lat:57.705,lon:11.97,t:'2026-06-10T08:01:00Z'},
  {lat:57.71,lon:11.97,t:'2026-06-10T08:02:00Z'}],
  stops:[{lat:57.705,lon:11.97,duracao_s:30,events:['openDoor']}]});
const nBefore=savedRecs.filter(Boolean).length;
global.FileReader=class{readAsText(){this.onload({target:{result:scriptJSON}})}};
global.alert=()=>{};
importRecsJSON({files:[{name:'ciclo.json'}],value:''});
const imp=savedRecs.filter(Boolean).pop();
console.assert(savedRecs.filter(Boolean).length===nBefore+1,'import count FAIL');
console.assert(imp.points[0].lng===11.97&&typeof imp.points[0].t==='number','lon→lng/ISO-t normalize FAIL');
console.assert(imp.stops[0].dur_s===30&&imp.stops[0].events[0]==='openDoor','duracao_s/events FAIL');
console.assert(imp.dist>1.0,'auto dist FAIL: '+imp.dist);
console.log('8. script JSON import OK — dist',imp.dist.toFixed(2),'km, dur_s',imp.stops[0].dur_s);

// ══ TEST 9: 10m radius — arrival fires at ~8m, not at 50m ══
el('rng-radius').value='10';
stops=[{id:1,name:'P1',lat:57.70,lng:11.97,dur_s:10,elapsed:0,running:false,intervalId:null,state:'waiting'}];
stopMarkers={1:{setIcon(){}}};insideStop.clear();departGate=null;navActive=true;
gps(57.7005,11.97,3);  // ~55m away, slow (eff radius = 18m)
console.assert(stops[0].state==='waiting','10m radius FAIL — arrived at 55m');
gps(57.70007,11.97,3); // ~8m away
console.assert(stops[0].state==='current','10m arrival FAIL at 8m');
console.log('9. 10m radius arrival OK');

console.log('ALL EXTENDED TESTS PASSED');

// ══ TEST 10: rotation — container transform, no Leaflet pane involvement ══
setMapBearing(-90);
console.assert(/rotate\(-90deg\)/.test(__mapC.style.transform),'container rotate FAIL: '+__mapC.style.transform);
console.assert(__mapC.classList.contains('rotated'),'rotated class FAIL');
// wraparound continuity: -350 after -10 must unwrap (no +340° long spin)
setMapBearing(-10); setMapBearing(-350);
const m=__mapC.style.transform.match(/rotate\((-?[\d.]+)deg\)/);
console.assert(m&&Math.abs(+m[1]-10)<0.01,'unwrap FAIL: '+__mapC.style.transform); // -350 ≡ +10, near -10
setMapBearing(0);
console.assert(__mapC.style.transform===''||/rotate\((-?360|0)deg\)/.test(__mapC.style.transform),'north reset FAIL');
console.log('10. container rotation + unwrap OK');

// ══ TEST 11: voice — no mid-word cancel loop, dedup per semantic key ══
__speech.spoken=[];__speech.cancels=0;
for(const k in _spokenAt)delete _spokenAt[k];
voiceOn=true;
// simulate the field loop: event announce + maneuver announce alternating each GPS tick
for(let tick=0;tick<10;tick++){
  speakText('Stop 1: open doors required',true);   // was re-firing every other tick
  speakText('In 500 meters, turn right');           // maneuver
}
const s1=__speech.spoken.filter(t=>t.includes('open doors')).length;
const s2=__speech.spoken.filter(t=>t.includes('500 meters')).length;
console.assert(s1===1,'event announce repeat FAIL: spoken '+s1+'x');
console.assert(s2===1,'maneuver dedup FAIL: spoken '+s2+'x');
// priority cancels current speech exactly once (not once per tick)
console.assert(__speech.cancels===1,'cancel storm FAIL: '+__speech.cancels+' cancels');
// different stop number = same semantic key → still suppressed within cooldown (no chatter),
// but a genuinely different sentence passes
speakText('Turn left ahead');
console.assert(__speech.spoken.includes('Turn left ahead'),'distinct message blocked FAIL');
console.log('11. voice dedup OK — spoken:',__speech.spoken.length,'cancels:',__speech.cancels);

console.log('ALL v5 TESTS PASSED');

// ══ TEST 12: GPS jitter at a stop must NOT create a phantom U-turn ══
routePts=[];
for(let i=0;i<60;i++)routePts.push({lat:57.70+i*0.0001,lon:11.97});       // north ~660m
const jl=57.706, jg=11.97;                                                  // "parked" cluster
for(let i=0;i<15;i++)routePts.push({lat:jl+(i%3-1)*0.00002,lon:jg+((i*7)%3-1)*0.00002}); // ±2m jitter
for(let i=1;i<60;i++)routePts.push({lat:jl+i*0.0001,lon:11.97});            // continue north
buildCumDist(routePts);totalRouteDist=routeCumDist[routeCumDist.length-1];
maneuvers=buildManeuvers(routePts);
const phantom=maneuvers.filter(m=>m.type==='uturn'||m.type==='shr'||m.type==='shl');
console.assert(phantom.length===0,'PHANTOM U-TURN STILL PRESENT: '+JSON.stringify(phantom.map(p=>p.type)));
console.assert(maneuvers.filter(m=>m.type!=='arrive').length===0,'straight route got turns: '+maneuvers.map(m=>m.type));
console.log('12. jitter cluster filtered OK — maneuvers:',maneuvers.map(m=>m.type).join(','));

// ══ TEST 13: recording decimation — parked vehicle adds ~no points ══
navActive=false;isRec=true;recPoints=[];recStops=[];recStopCandidate=null;recLayer=null;
fake=realNow();
for(let i=0;i<10;i++){fake+=1000;gps(57.70+(i%2)*0.000005,11.97,1);} // parked, <1m jitter, 10s
const parkedPts=recPoints.length;
console.assert(parkedPts<=3,'decimation FAIL — '+parkedPts+' jitter points recorded');
for(let i=1;i<=5;i++){fake+=1000;gps(57.70+i*0.0002,11.97,40);}      // moving ~22m/s
console.assert(recPoints.length>=parkedPts+5,'moving points lost: '+recPoints.length);
console.log('13. decimation OK — parked:',parkedPts,'pts, after moving:',recPoints.length);

// ══ TEST 14: orphaned markers cleared on new recording ══
let removed=0; map.removeLayer=()=>{removed++};
extraMarkers.length=0;
extraMarkers.push({_m:1},{_m:2},{_m:3}); // simulate start/end dots + rec pin
stopMarkers={1:{_m:4}};
routeLayer=routeAheadLayer=routeRemainLayer=routeDoneLayer=recLayer={addTo(){return this}};
clearMapLayers();
console.assert(extraMarkers.length===0,'extraMarkers not cleared');
console.assert(removed>=8,'removeLayer count FAIL: '+removed); // 5 layers + 1 stopMarker + 3 extras... >=8
console.log('14. orphaned markers cleared OK — removeLayer called',removed,'x');

console.log('ALL v6 TESTS PASSED');

// ══ TEST 15: GTA/VBC classification — synthetic Ci2 cycle ══
// Target: avg ~19 (15-23), drive ~27 (23-32), max ~54 (50-60), idle ~30% (27-36), 3 st/km (2.5-5)
fake=realNow();
const apts=[];let alat=57.70,t0g=fake;
function drive(sec,ms){for(let i=0;i<sec;i++){alat+=ms*0.0000090;t0g+=1000;apts.push({lat:alat,lng:11.97,t:t0g,alt:30+apts.length*0.05});}}
function park(sec){for(let i=0;i<sec;i+=10){t0g+=10000;apts.push({lat:alat,lng:11.97,t:t0g,alt:30+apts.length*0.05});}}
apts.push({lat:alat,lng:11.97,t:t0g,alt:30});
drive(120,7.5); park(60); drive(80,7.5); drive(4,15); park(50); drive(60,7.5);
const gta=calcGTAScore(apts,[{},{},{},{},{},{}]); // 6 stops over ~2 km
console.assert(gta.cls==='Ci2','GTA class FAIL: '+JSON.stringify({cls:gta.cls,m:gta.metrics}));
console.assert(gta.matched>=4,'GTA criteria FAIL: '+gta.matched+'/5 '+JSON.stringify(gta.detail));
const eg=calcElevGain(apts);
console.assert(eg!=null&&eg>=8,'elev gain FAIL: '+eg);
console.assert(calcGTAScore([{lat:1,lng:1,t:1}],[]).matched===null,'GTA null-guard FAIL');
// LH cycle: 0 stops, highway profile (avg~64, drive~68, max~95, idle~6%)
const lpts=[];alat=57.70;t0g=fake+1e7;lpts.push({lat:alat,lng:11.97,t:t0g});
for(let i=0;i<150;i++){alat+=26.4*0.0000090;t0g+=1000;lpts.push({lat:alat,lng:11.97,t:t0g});} // 95 km/h
for(let i=0;i<150;i++){alat+=11.4*0.0000090;t0g+=1000;lpts.push({lat:alat,lng:11.97,t:t0g});} // 41 km/h
for(let i=0;i<20;i+=10){t0g+=10000;lpts.push({lat:alat,lng:11.97,t:t0g});}                    // idle
const lh=calcGTAScore(lpts,[]);
console.assert(lh.cls==='LH1'&&lh.matched>=4,'LH class FAIL: '+lh.cls+' '+lh.matched+' '+JSON.stringify(lh.metrics));
console.log('15. GTA classification OK —',gta.cls,gta.matched+'/5, LH cycle →',lh.cls,lh.matched+'/5');

// ══ TEST 16: editable cycle name + GTA stored on save ══
global.__promptReply='Sion Lap 3';
isRec=true;navActive=false;recStops=[{},{},{},{},{},{}];recStopCandidate=null;
recPoints=apts.map(p=>({...p}));
stopRec();
const last=savedRecs.filter(Boolean).pop();
console.assert(last.name==='Sion Lap 3','name edit FAIL: '+last.name);
console.assert(last.score?.cls==='Ci2'&&last.score.matched!=null&&last.elev!=null,'stored GTA FAIL: '+JSON.stringify({c:last.score?.cls,e:last.elev}));
delete global.__promptReply;
console.log('16. editable name + stored GTA OK:',last.score.cls,last.score.matched+'/5');

// ══ TEST 17: seg_avg attached to nav stops and shown in HUD chip ══
console.assert(stops.length===0||true,'');
const spts=[];fake=realNow();
for(let i=0;i<120;i++)spts.push({lat:57.70+i*0.00009,lng:11.97,t:fake+i*1000}); // 10 m/s
savedRecs.push({name:'SegTest',dist:1,date:new Date(),points:spts,
  stops:[{lat:spts[60].lat,lng:11.97,t:spts[60].t,dur_s:20}]});
loadRec(savedRecs.length-1);
console.assert(stops[0].seg_avg!=null&&Math.abs(stops[0].seg_avg-36)<3,'seg_avg attach FAIL: '+stops[0].seg_avg);
navActive=true;
gps(57.70,11.97,30);
console.assert(/Ø 3[3-9]/.test(el('hud-tgt').textContent),'HUD target chip FAIL: "'+el('hud-tgt').textContent+'"');
console.log('17. leg pacing in HUD OK:',el('hud-tgt').textContent);

// ══ TEST 18: tapping active tab collapses sheet (user only) ══
shState='mid';
el('stab-rota').classList.add('active');
switchTab('rota',true);
console.assert(shState==='peek','tab collapse FAIL: '+shState);
switchTab('rota');           // programmatic — must NOT collapse from peek→stay/open
console.assert(shState==='mid','programmatic open FAIL: '+shState);
switchTab('gravadas',true);  // different tab — opens
console.assert(shState==='mid','tab open FAIL: '+shState);
console.log('18. tab retract/expand OK');

console.log('ALL v7 TESTS PASSED');

// ══ TEST 19: sheet collapse behavior ══
shState='peek';
toggleSheetCollapse();
console.assert(shState==='mid','chevron expand FAIL: '+shState);
toggleSheetCollapse();
console.assert(shState==='peek','chevron collapse FAIL: '+shState);
// swipe down from mid → peek (was stuck at mid before)
shState='mid'; tsY=100;
shTE({changedTouches:[{clientY:200}]});
console.assert(shState==='peek','swipe-down collapse FAIL: '+shState);
// swipe up from peek → mid
tsY=200; shTE({changedTouches:[{clientY:100}]});
console.assert(shState==='mid','swipe-up open FAIL: '+shState);
console.log('19. sheet collapse/expand OK');

console.log('ALL v8 TESTS PASSED');

// ══ TEST 20: crash recovery — in-flight flush + boot recover ══
isRec=true;recPoints=[];recStops=[];recStopCandidate=null;_lastFlush=0;fake=realNow();
for(let i=0;i<8;i++){fake+=6000;gps(57.72+i*0.0005,11.97,40);} // 48s drive → ≥1 flush
console.assert(localStorage.getItem('gpx-nav-inflight')!=null,'inflight flush FAIL');
isRec=false; // simulate app crash (no stopRec)
const nRecs=savedRecs.filter(Boolean).length;
checkInflightRecovery(); // confirm mock returns true
console.assert(savedRecs.filter(Boolean).length===nRecs+1,'recovery FAIL');
console.assert(localStorage.getItem('gpx-nav-inflight')==null,'inflight not cleared');
console.assert(/^Recovered/.test(savedRecs.filter(Boolean).pop().name),'recovery name FAIL');
console.log('20. crash recovery OK');

// ══ TEST 21: quota guard warns above 3.5 MB ══
let alerts=[];const oldAlert=global.alert;global.alert=m=>alerts.push(m);
_quotaWarned=false;
localStorage.setItem('bigblob','x'.repeat(1.9*1024*1024)); // ~3.8MB in UTF-16 estimate
checkQuota();
console.assert(alerts.some(a=>/Storage/.test(a)),'quota warn FAIL: '+alerts.length);
localStorage.removeItem('bigblob');global.alert=oldAlert;_quotaWarned=false;
console.log('21. quota guard OK');

// ══ TEST 22: altitude survives persistence round-trip (elev was lost on reload) ══
savedRecs.length=0;
savedRecs.push({name:'AltTest',dist:1,date:new Date(),points:[
  {lat:57.7,lng:11.97,t:1,alt:100.04},{lat:57.71,lng:11.97,t:2,alt:120.06}],stops:[]});
saveRecordings();
const stored=JSON.parse(localStorage.getItem('gpx-nav-recs'));
console.assert(stored[0].points[0].alt===100&&stored[0].points[1].alt===120.1,'alt persist FAIL: '+JSON.stringify(stored[0].points));
console.log('22. altitude persistence OK');

// ══ TEST 23: Next Stop Card content during nav ══
stops=[{id:1,name:'P1',lat:57.80,lng:11.97,dur_s:45,elapsed:0,running:false,intervalId:null,
  state:'waiting',events:['openDoor'],seg_avg:31.5,photo:null}];
stopMarkers={1:{setIcon(){}}};insideStop.clear();departGate=null;navActive=true;
el('rng-radius').value='10';
gps(57.7964,11.97,40); // ~400 m away
console.assert(el('nsc').style.display==='block','NSC hidden FAIL');
console.assert(/40[0-9] m|39[0-9] m/.test(el('nsc-dist').textContent),'NSC dist FAIL: '+el('nsc-dist').textContent);
console.assert(el('nsc-evt').textContent.includes('🚪'),'NSC events FAIL');
console.assert(/31\.5/.test(el('nsc-leg').textContent),'NSC leg FAIL: '+el('nsc-leg').textContent);
console.assert(el('nsc-count').textContent==='1/1','NSC count FAIL: '+el('nsc-count').textContent);
// at stop: countdown mode
stops[0].state='current';stops[0].elapsed=15;
gps(57.80,11.97,1);
console.assert(el('nsc-title').textContent.includes('AT STOP'),'NSC atstop FAIL');
console.assert(el('nsc-dist').textContent==='00:30','NSC countdown FAIL: '+el('nsc-dist').textContent);
navActive=false;stops=[];
console.log('23. Next Stop Card OK');

console.log('ALL v9-DEV TESTS PASSED');

// ══ TEST 24: GPS simulator — full nav replay from a recorded cycle ══
// Build a "physically recorded" cycle: drive 60s @10 m/s, dwell 30s, drive 40s
fake=realNow();let qlat=57.90,qt=fake;
const qpts=[{lat:qlat,lng:11.97,t:qt}];
for(let i=0;i<60;i++){qlat+=10*0.0000090;qt+=1000;qpts.push({lat:qlat,lng:11.97,t:qt});}
const stopPos=qlat;
for(let i=0;i<30;i+=5){qt+=5000;qpts.push({lat:qlat,lng:11.97,t:qt});}
for(let i=0;i<40;i++){qlat+=10*0.0000090;qt+=1000;qpts.push({lat:qlat,lng:11.97,t:qt});}
savedRecs.push({name:'SimCycle',dist:1,date:new Date(),points:qpts,
  stops:[{lat:stopPos,lng:11.97,t:qpts[61].t,dur_s:25,events:[]}]});
const simRecIdx=savedRecs.length-1;
loadRec(simRecIdx);
console.assert(stops.length===1&&routePts.length===qpts.length,'sim loadRec FAIL');
navActive=true;watchId=7;el('rng-sim').value='10';
__speech.spoken=[];for(const k in _spokenAt)delete _spokenAt[k];
startSim(simRecIdx);
// mock setTimeout runs <=1000ms inline → whole sim executed synchronously
console.assert(simRec===null,'sim did not finish: idx '+simIdx); // simTimer===0 is the sync-mock artifact
console.assert(stops[0].state==='done'||stops[0].state==='current','SIM arrival FAIL: '+stops[0].state);
console.assert(lastRouteIdx>50,'SIM route matching FAIL: '+lastRouteIdx);
console.assert(__speech.spoken.some(t=>/Arrived at stop/.test(t)),'SIM voice FAIL');
console.assert(watchId!=null,'real GPS not resumed after sim');
console.log('24. GPS simulator OK — arrival, matching, voice all replayed; stop state:',stops[0].state);

console.log('ALL v10-DEV TESTS PASSED');
