import {SpatialIndex} from '../src/canvas/geometry.ts';
import {performance} from 'node:perf_hooks';
const items=Array.from({length:100000},(_,i)=>({id:String(i),type:'image',x:(i%400)*520,y:Math.floor(i/400)*400,width:480,height:360,z:i}));
const index=new SpatialIndex(),start=performance.now();index.reset(items);const build=performance.now()-start,times=[];let count=0;
for(let i=0;i<1000;i++){const start=performance.now();const result=index.search({x:(i%300)*510,y:(i%150)*390,width:1920,height:1080});times.push(performance.now()-start);count+=result.length;}
times.sort((a,b)=>a-b);console.log(JSON.stringify({scope:'Spatial lookup only, not GPU or distinct-image decode',objects:items.length,queries:times.length,buildMs:+build.toFixed(2),p95Ms:+times[949].toFixed(4),p99Ms:+times[989].toFixed(4),averageVisible:count/times.length},null,2));
