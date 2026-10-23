import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { Place } from '../worker/types';

type Props = { places: Place[]; selected: string; onSelect: (id: string) => void; demo: boolean; activity: boolean; dark: boolean; reset: number; zoom: number };
const raster = import.meta.env.VITE_GIS_IMAGE_URL as string | undefined;
export default function CampusScene({places, selected, onSelect, demo, activity, dark, reset, zoom}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState('');
  const selectRef = useRef(onSelect); selectRef.current = onSelect;
  useEffect(() => {
    const el = host.current!;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false }); }
    catch { setFailure('当前设备无法开启 3D 视图，请使用右侧地点列表。'); return; }
    const scene = new THREE.Scene();
    const background = dark ? '#07121d' : '#c5d2ce';
    scene.background = new THREE.Color(background); scene.fog = new THREE.Fog(background, 95, 190);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.7)); renderer.setSize(el.clientWidth, el.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = dark ? 1.4 : 1.2;
    el.appendChild(renderer.domElement);
    const camera = new THREE.PerspectiveCamera(39, el.clientWidth / el.clientHeight, .1, 250);
    camera.position.set(62 / zoom, 73 / zoom, 77 / zoom); camera.lookAt(0,0,0);
    const controls = new OrbitControls(camera, renderer.domElement); controls.target.set(0,0,0); controls.enableDamping = true;
    controls.minDistance = 25; controls.maxDistance = 135; controls.maxPolarAngle = Math.PI * .43; controls.minPolarAngle = .15;
    const hemi = new THREE.HemisphereLight(dark ? '#b2d6ff' : '#effaff', '#172720', dark ? 1.2 : 2.5); scene.add(hemi);
    const sun = new THREE.DirectionalLight('#d0ddff', dark ? 1.8 : 3); sun.position.set(-30,70,20); scene.add(sun);
    const group = new THREE.Group(); scene.add(group);
    const materials: THREE.Material[] = [];
    const material = (color: string, emission?: string) => { const m = new THREE.MeshStandardMaterial({color, roughness: .85, ...(emission ? {emissive:emission,emissiveIntensity: 1.8} : {})}); materials.push(m); return m; };
    const grass = material(dark ? '#1b3430' : '#729b77');
    const building = material(dark ? '#62798b' : '#c3d1cc'); const roof = material(dark ? '#3a5269' : '#92a7b0');
    const road = material(dark ? '#344448' : '#9dafa4'); const windowMat = material('#ffe6a5', dark ? '#ffc269' : undefined);
    const treeMat = material(dark ? '#24493a' : '#3f7751'); const trunk = material('#4e4638'); const blue = material('#168cff','#168cff');
    const orange = material('#ff903a','#ff6a16'); const lampMat = material('#ffdf9c', '#ffd69a');
    const box = (x: number,y: number,z: number,w:number,h:number,d:number,mat:THREE.Material) => { const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);m.position.set(x,y,z);group.add(m);return m; };
    box(0,-.55,0,92,1,82,grass);
    let mapTexture: THREE.Texture | undefined;
    if (raster) {
      const map = new THREE.Mesh(new THREE.PlaneGeometry(92,82),new THREE.MeshBasicMaterial({color:'#ffffff'})); map.rotation.x = -Math.PI/2;map.position.y=.02;group.add(map);
      new THREE.TextureLoader().load(raster, t=>{mapTexture=t;t.colorSpace=THREE.SRGBColorSpace;(map.material as THREE.MeshBasicMaterial).map=t;map.material.needsUpdate=true;},undefined,()=>setFailure('GIS 图层加载失败；请检查图源与跨域配置。'));
    } else {
      [-31,-11,11,31].forEach(x=>box(x,.02,0,2.7,.12,82,road));
      [-29,-9,12,31].forEach(z=>box(0,.03,z,92,.15,2.8,road));
      for(let i=0;i<7;i++) for(let j=0;j<5;j++) {
        if((i===3&&j===2)||(i===0&&j===4)||(i===5&&j===1)) continue;
        const x=-39+i*12.7,z=-33+j*15.3,h=3.7+((i*7+j*3)%4)*1.2,w=7.1+(j%2),d=7.5;
        box(x,h/2,z,w,h,d,building);box(x,h+.25,z,w+.45,.5,d+.45,roof);
        for(let floor=0;floor<Math.floor(h/1.3);floor++)for(let k=0;k<5;k++){
          if((i+j+k+floor)%5===0)continue;
          box(x-w/2+.9+k*1.3,1+floor*1.3,z+d/2+.03,.5,.64,.06,windowMat);
          box(x+w/2+.03,1+floor*1.3,z-d/2+.9+k*1.3,.06,.64,.5,windowMat);
        }
      }
      const library = box(0,3.5,0,13,7,10,building);library.name='library';box(0,7.3,0,13.7,.6,10.7,roof);box(0,.15,7,18,.2,4,road);
      for(let k=0;k<8;k++){box(-5+k*1.4,4.1,5.04,.65,4,.08,windowMat);}
      for(let i=0;i<160;i++) {
        const x=((i*37)%900)/10-45,z=((i*61)%800)/10-40;
        if(Math.abs(x%20)<2||Math.abs(z%20)<2) continue;
        const h=1.5+(i%4)*.3;
        const t=new THREE.Mesh(new THREE.ConeGeometry(1.0,h*1.5,7),treeMat);t.position.set(x,h,z);group.add(t);box(x,.5,z,.24,1,.24,trunk);
      }
      for(let i=0;i<44;i++) {
        const x=-42+(i%11)*8.1,z=-10+Math.floor(i/11)*20;
        box(x,.8,z,.12,1.6,.12,trunk);box(x,1.7,z,.3,.22,.3,lampMat);
      }
      const field=box(-33,.12,29,16,.18,10,material('#224e43'));const track=new THREE.Mesh(new THREE.RingGeometry(6,7.4,48),material('#9a574a'));track.rotation.x=-Math.PI/2;track.scale.x=1.4;track.position.set(field.position.x,.24,field.position.z);group.add(track);
    }
    const pickables: THREE.Object3D[]=[];
    places.forEach(p=>{
      const x=(p.anchor.x-.5)*92,z=(p.anchor.y-.5)*82;
      const chosen=p.id===selected;
      const ring=new THREE.Mesh(new THREE.RingGeometry(chosen?2.1:1.2,chosen?2.3:1.35,64),new THREE.MeshBasicMaterial({color:chosen?'#5bcaff':'#7f9dad',side:THREE.DoubleSide,transparent:true,opacity:chosen?.95:.55}));ring.rotation.x=-Math.PI/2;ring.position.set(x,.3,z);group.add(ring);
      const marker=new THREE.Mesh(new THREE.ConeGeometry(chosen?.8:.55,chosen?2.3:1.7,12),chosen?blue:roof);marker.rotation.z=Math.PI;marker.position.set(x,chosen?5:3,z);marker.userData.place=p.id;group.add(marker);pickables.push(marker);
    });
    const actors: THREE.Mesh[]=[];
    if(demo&&activity)for(let i=0;i<100;i++){
      const a=new THREE.Mesh(new THREE.SphereGeometry(i%4===0?.23:.16,5,5),i%4===0?orange:blue);a.position.set(-35+(i*13.7)%70,.4,-30+(i*7.1)%60);group.add(a);actors.push(a);
    }
    const composer=new EffectComposer(renderer);composer.addPass(new RenderPass(scene,camera));
    const bloom=new UnrealBloomPass(new THREE.Vector2(el.clientWidth,el.clientHeight),dark?.45:.12,.6,1);composer.addPass(bloom);
    const ray=new THREE.Raycaster(),pointer=new THREE.Vector2();let downX=0,downY=0;
    const down=(e:PointerEvent)=>{downX=e.clientX;downY=e.clientY;};
    const click=(e:PointerEvent)=>{if(Math.hypot(e.clientX-downX,e.clientY-downY)>7)return;const r=renderer.domElement.getBoundingClientRect();pointer.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);ray.setFromCamera(pointer,camera);const hit=ray.intersectObjects(pickables)[0];if(hit)selectRef.current(hit.object.userData.place);};
    renderer.domElement.addEventListener('pointerdown',down);renderer.domElement.addEventListener('pointerup',click);
    const resize = new ResizeObserver(()=>{const w=el.clientWidth,h=el.clientHeight;if(!w||!h)return;renderer.setSize(w,h);composer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();});resize.observe(el);
    let frame=0;const animate=(time:number)=>{frame=requestAnimationFrame(animate);controls.update();actors.forEach((a,i)=>{a.position.x+=Math.sin(i+time*.0003)*.003;});composer.render();};frame=requestAnimationFrame(animate);
    return ()=>{cancelAnimationFrame(frame);resize.disconnect();controls.dispose();renderer.domElement.removeEventListener('pointerdown',down);renderer.domElement.removeEventListener('pointerup',click);scene.traverse(o=>{if(o instanceof THREE.Mesh){o.geometry.dispose();const m=Array.isArray(o.material)?o.material:[o.material];m.forEach(x=>x.dispose());}});mapTexture?.dispose();bloom.dispose();composer.dispose();renderer.dispose();el.replaceChildren();};
  },[places,selected,demo,activity,dark,reset,zoom]);
  return <div ref={host} className="scene" aria-label="可拖动、缩放的校园三维示意地图">{failure&&<div className="scene-error" role="status">{failure}</div>}</div>;
}
