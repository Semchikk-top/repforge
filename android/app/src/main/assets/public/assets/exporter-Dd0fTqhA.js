import{ce as w,c7 as g,p as x,O as h,B as u}from"./index-BNbJOn9C.js";const m=(t,e)=>(!e.from||t>=e.from)&&(!e.to||t<=e.to);function $(t){let e=t==null?"":String(t);return/^[=+\-@\t\r]/.test(e)&&!/^-?\d+([.,]\d+)?$/.test(e)&&(e="'"+e),/[";\n\r]/.test(e)?'"'+e.replace(/"/g,'""')+'"':e}const S={normal:"обычный",drop:"дроп-сет",restpause:"rest-pause"};function y(t,e,r={}){var a;const s=[["Дата","Тренировка","Упражнение","Подход","Тип","Вес, кг","Повторы","RPE","Заметка","Дистанция, км","Время, с"]];for(const l of[...t].filter(n=>!n.deletedAt&&n.status==="done"&&m(n.date,r)).sort((n,i)=>n.date.localeCompare(i.date)))for(const n of l.exercises){const i=((a=e.get(n.exerciseId))==null?void 0:a.name)??"Удалённое упражнение";n.cardio&&s.push([l.date,l.title,i,"","кардио","","","","",(n.cardio.distanceM/1e3).toFixed(2),String(n.cardio.durationSec)]),n.sets.filter(o=>o.done).forEach((o,c)=>s.push([l.date,l.title,i,String(c+1),S[o.kind??"normal"],String(o.weight),String(o.reps),o.rpe===void 0?"":String(o.rpe),o.note??"","",""]))}return s.map(l=>l.map($).join(";")).join(`\r
`)+`\r
`}function F(t,e){const r=(t.workouts??[]).filter(a=>m(a.date,e)),s=new Set(r.map(a=>a.id));return{...t,workouts:r,tracks:(t.tracks??[]).filter(a=>s.has(a.workoutId)),body:(t.body??[]).filter(a=>m(a.date,e)),checkins:(t.checkins??[]).filter(a=>m(a.date,e))}}function v(t,e,r){const s=(l,n)=>l+(n-l)*r,a={...t,lat:s(t.lat,e.lat),lon:s(t.lon,e.lon)};return typeof t.t=="number"&&typeof e.t=="number"&&(a.t=s(t.t,e.t)),typeof t.ele=="number"&&typeof e.ele=="number"&&(a.ele=s(t.ele,e.ele)),a}function k(t,e){if(!(e>0)||t.length===0)return t;const r=[0];for(let i=1;i<t.length;i++)r.push(r[i-1]+w(t[i-1].lat,t[i-1].lon,t[i].lat,t[i].lon));const s=r[r.length-1];if(s<2*e+30)return[];const a=e,l=s-e,n=i=>{let o=1;for(;o<t.length-1&&r[o]<i;)o++;const c=r[o]-r[o-1];return v(t[o-1],t[o],c>0?(i-r[o-1])/c:0)};return[n(a),...t.filter((i,o)=>r[o]>a&&r[o]<l),n(l)]}const f=t=>t.replace(/[<>&"']/g,e=>({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;","'":"&apos;"})[e]);function O(t,e,r,s=0){const l=k(r.map(g),s).map(n=>{const i=n.ele===null?"":`<ele>${n.ele.toFixed(1)}</ele>`;return`      <trkpt lat="${n.lat.toFixed(5)}" lon="${n.lon.toFixed(5)}">${i}<time>${new Date(e+n.t*1e3).toISOString()}</time></trkpt>`}).join(`
`);return`<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="repforge" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${f(t)}</name><time>${new Date(e).toISOString()}</time></metadata>
  <trk>
    <name>${f(t)}</name>
    <trkseg>
${l}
    </trkseg>
  </trk>
</gpx>
`}function A(t,e=0){return`<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="repforge" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Маршруты</name></metadata>
${t.map(s=>{const a=k(s.track.map(g),e);if(a.length<2)return"";const l=a.map(n=>{const i=n.ele===null?"":`<ele>${n.ele.toFixed(1)}</ele>`;return`      <trkpt lat="${n.lat.toFixed(5)}" lon="${n.lon.toFixed(5)}">${i}<time>${new Date(s.startMs+n.t*1e3).toISOString()}</time></trkpt>`}).join(`
`);return`  <trk>
    <name>${f(s.name)}</name>
    <trkseg>
${l}
    </trkseg>
  </trk>`}).filter(Boolean).join(`
`)}
</gpx>
`}function P(t,e,r){x.files.save(t,r,e).catch(()=>{})}async function b(t){return JSON.stringify(F(JSON.parse(await h()),t),null,2)}async function j(t){const[e,r]=await Promise.all([u.workouts.toArray(),u.exercises.toArray()]);return"\uFEFF"+y(e,new Map(r.map(s=>[s.id,s])),t)}async function D(t,e){var i;const[r,s]=await Promise.all([u.workouts.toArray(),u.exercises.toArray()]),a=new Map(s.map(o=>[o.id,o.name])),l=[];for(const o of r)if(!(o.deletedAt||o.status!=="done"||t.from&&o.date<t.from||t.to&&o.date>t.to))for(const c of o.exercises){const p=(i=c.cardio)==null?void 0:i.trackId,d=p?await u.tracks.get(p):void 0;d&&!d.deletedAt&&l.push({name:`${o.date} ${a.get(c.exerciseId)??"Маршрут"}`,startMs:o.startedAt??Date.parse(o.date),track:d.points})}const n=A(l,e);return{xml:n,count:(n.match(/<trk>/g)??[]).length}}export{O as a,b,P as d,D as r,k as t,j as w};
