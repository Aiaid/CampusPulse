import { useEffect, useRef, useState } from 'react';
import type { Place } from '../worker/types';
const origin = (import.meta.env.VITE_GIS_TILE_ORIGIN || 'https://gis.ccnu.edu.cn').replace(/\/$/, '');
const center={x:.6370442708,y:.3686116536};
export default function GisMap({places,selected,onSelect,zoom,onZoom,demo,activity,reset}:{places:Place[];selected:string;onSelect:(id:string)=>void;zoom:number;onZoom:(z:number)=>void;demo:boolean;activity:boolean;reset:number}){
 const host=useRef<HTMLDivElement>(null);const [size,setSize]=useState({w:1200,h:800});const [offset,setOffset]=useState({x:0,y:0});const [failed,setFailed]=useState(false);const [attempt,setAttempt]=useState(0);const drag=useRef<{x:number;y:number;left:number;top:number}|null>(null);
 useEffect(()=>{const el=host.current!;const r=new ResizeObserver(()=>setSize({w:el.clientWidth,h:el.clientHeight}));r.observe(el);return()=>r.disconnect();},[]);
 useEffect(()=>setOffset({x:0,y:0}),[reset]);
 const cx=size.w*(size.w<800?.5:.4)+offset.x,cy=size.h*(size.w<800?.35:.52)+offset.y;
 const left=cx-center.x*3072*zoom,top=cy-center.y*3072*zoom;
 const x0=Math.max(0,Math.floor(-left/(256*zoom))),x1=Math.min(11,Math.floor((size.w-left)/(256*zoom)));
 const y0=Math.max(0,Math.floor(-top/(256*zoom))),y1=Math.min(11,Math.floor((size.h-top)/(256*zoom)));
 const tiles=[];for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)tiles.push({x,y});
 return <div ref={host} className="gis-map" onWheel={e=>onZoom(Math.max(.5,Math.min(2.5,zoom-e.deltaY*.001)))} onPointerDown={e=>{if((e.target as HTMLElement).closest('button'))return;drag.current={x:e.clientX,y:e.clientY,left:offset.x,top:offset.y};e.currentTarget.setPointerCapture(e.pointerId);}} onPointerMove={e=>{const d=drag.current;if(d)setOffset({x:d.left+e.clientX-d.x,y:d.top+e.clientY-d.y});}} onPointerUp={()=>drag.current=null} onPointerCancel={()=>drag.current=null}>
  <div className="tile-world" style={{left,top,transform:`scale(${zoom})`,transformOrigin:'0 0'}}>
   {tiles.map(({x,y})=><img key={`${attempt}_${x}_${y}`} src={`${origin}/mapdata/zoom4/${x}_${y}.jpg`} alt="" draggable={false} onError={e=>{e.currentTarget.style.visibility="hidden";setFailed(true);}} style={{left:x*256,top:y*256}}/>)}
   {places.filter(p=>p.gis_anchor?.verified).map(p=><button key={p.id} className={`map-pin ${selected===p.id?'selected':''}`} style={{left:`${p.gis_anchor!.x*100}%`,top:`${p.gis_anchor!.y*100}%`}} onClick={()=>onSelect(p.id)}><span className="pin-dot"/><span>{p.name}</span></button>)}
   {demo&&activity&&Array.from({length:48},(_,i)=><i key={i} className={`activity-light ${i%4===0?'orange':''}`} style={{left:`${center.x*100-6+(i*1.13)%12}%`,top:`${center.y*100-5+(i*1.21)%10}%`,animationDelay:`${i*.1}s`}}/>)}
  </div>
  {failed&&<div className="gis-notice" role="status">部分华师 GIS 图块未加载。可重试或切换三维示意；地点数据独立可查。<button onClick={()=>{setFailed(false);setAttempt(n=>n+1);}}>重新加载</button></div>}
 </div>
}
