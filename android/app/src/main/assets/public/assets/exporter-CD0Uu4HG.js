import{cG as w,cy as g,N as x,z as h,s as m}from"./index-DNEaocjS.js";const u=(t,e)=>(!e.from||t>=e.from)&&(!e.to||t<=e.to);function $(t){let e=t==null?"":String(t);return/^[=+\-@\t\r]/.test(e)&&!/^-?\d+([.,]\d+)?$/.test(e)&&(e="'"+e),/[";\n\r]/.test(e)?'"'+e.replace(/"/g,'""')+'"':e}const S=t=>typeof t=="number"&&Number.isFinite(t)&&t>=0?String(Math.round(t)):"",y={normal:"обычный",drop:"дроп-сет",restpause:"rest-pause"};function F(t,e,a={}){var r;const s=[["Дата","Тренировка","Упражнение","Подход","Тип","Вес, кг","Повторы","RPE","Заметка","Дистанция, км","Время, с","Время подхода, с"]];for(const l of[...t].filter(n=>!n.deletedAt&&n.status==="done"&&u(n.date,a)).sort((n,i)=>n.date.localeCompare(i.date)))for(const n of l.exercises){const i=((r=e.get(n.exerciseId))==null?void 0:r.name)??"Удалённое упражнение";n.cardio&&s.push([l.date,l.title,i,"","кардио","","","","",(n.cardio.distanceM/1e3).toFixed(2),String(n.cardio.durationSec),""]),n.sets.filter(o=>o.done).forEach((o,c)=>s.push([l.date,l.title,i,String(c+1),y[o.kind??"normal"],String(o.weight),String(o.reps),o.rpe===void 0?"":String(o.rpe),o.note??"","","",S(o.workSec)]))}return s.map(l=>l.map($).join(";")).join(`\r
`)+`\r
`}function A(t,e){const a=(t.workouts??[]).filter(r=>u(r.date,e)),s=new Set(a.map(r=>r.id));return{...t,workouts:a,tracks:(t.tracks??[]).filter(r=>s.has(r.workoutId)),body:(t.body??[]).filter(r=>u(r.date,e)),checkins:(t.checkins??[]).filter(r=>u(r.date,e)),learning:(t.learning??[]).filter(r=>u(r.date,e))}}function v(t,e,a){const s=(l,n)=>l+(n-l)*a,r={...t,lat:s(t.lat,e.lat),lon:s(t.lon,e.lon)};return typeof t.t=="number"&&typeof e.t=="number"&&(r.t=s(t.t,e.t)),typeof t.ele=="number"&&typeof e.ele=="number"&&(r.ele=s(t.ele,e.ele)),r}function k(t,e){if(!(e>0)||t.length===0)return t;const a=[0];for(let i=1;i<t.length;i++)a.push(a[i-1]+w(t[i-1].lat,t[i-1].lon,t[i].lat,t[i].lon));const s=a[a.length-1];if(s<2*e+30)return[];const r=e,l=s-e,n=i=>{let o=1;for(;o<t.length-1&&a[o]<i;)o++;const c=a[o]-a[o-1];return v(t[o-1],t[o],c>0?(i-a[o-1])/c:0)};return[n(r),...t.filter((i,o)=>a[o]>r&&a[o]<l),n(l)]}const f=t=>t.replace(/[<>&"']/g,e=>({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;","'":"&apos;"})[e]);function G(t,e,a,s=0){const l=k(a.map(g),s).map(n=>{const i=n.ele===null?"":`<ele>${n.ele.toFixed(1)}</ele>`;return`      <trkpt lat="${n.lat.toFixed(5)}" lon="${n.lon.toFixed(5)}">${i}<time>${new Date(e+n.t*1e3).toISOString()}</time></trkpt>`}).join(`
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
`}function I(t,e=0){return`<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="repforge" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Маршруты</name></metadata>
${t.map(s=>{const r=k(s.track.map(g),e);if(r.length<2)return"";const l=r.map(n=>{const i=n.ele===null?"":`<ele>${n.ele.toFixed(1)}</ele>`;return`      <trkpt lat="${n.lat.toFixed(5)}" lon="${n.lon.toFixed(5)}">${i}<time>${new Date(s.startMs+n.t*1e3).toISOString()}</time></trkpt>`}).join(`
`);return`  <trk>
    <name>${f(s.name)}</name>
    <trkseg>
${l}
    </trkseg>
  </trk>`}).filter(Boolean).join(`
`)}
</gpx>
`}function P(t,e,a){x.files.save(t,a,e).catch(()=>{})}async function j(t){return JSON.stringify(A(JSON.parse(await h()),t),null,2)}async function C(t){const[e,a]=await Promise.all([m.workouts.toArray(),m.exercises.toArray()]);return"\uFEFF"+F(e,new Map(a.map(s=>[s.id,s])),t)}async function D(t,e){var i;const[a,s]=await Promise.all([m.workouts.toArray(),m.exercises.toArray()]),r=new Map(s.map(o=>[o.id,o.name])),l=[];for(const o of a)if(!(o.deletedAt||o.status!=="done"||t.from&&o.date<t.from||t.to&&o.date>t.to))for(const c of o.exercises){const p=(i=c.cardio)==null?void 0:i.trackId,d=p?await m.tracks.get(p):void 0;d&&!d.deletedAt&&l.push({name:`${o.date} ${r.get(c.exerciseId)??"Маршрут"}`,startMs:o.startedAt??Date.parse(o.date),track:d.points})}const n=I(l,e);return{xml:n,count:(n.match(/<trk>/g)??[]).length}}export{C as a,j as b,G as c,P as d,D as r,k as t,S as w};
