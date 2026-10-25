import { chromium, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
// Frontend-only visual regression. Does not open the record form or submit
// observations; run it against a separately started local Vite preview.
const baseUrl=process.env.BASE_URL || 'http://127.0.0.1:5173/';
const out=path.resolve(process.env.SCREENSHOT_DIR || 'captures/library-lighting-qa')+path.sep;
fs.mkdirSync(out,{recursive:true});
const browser = await chromium.launch({headless:true});
const page = await browser.newPage({viewport:{width:1487,height:1058}});
const errors=[], warnings=[], checks=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='warning')warnings.push(message.text());});
const settings = async () => {
  if(!await page.getByRole('button',{name:'关闭场景设置'}).count())await page.getByRole('button',{name:'场景设置',exact:true}).click();
};
const closeSettings=async()=>page.getByRole('button',{name:'关闭场景设置'}).click();
const mode=async(name)=>{await settings();await page.getByRole('button',{name,exact:true}).click();await closeSettings();await page.waitForTimeout(350);};
const datasets=async(selector)=>page.locator(selector).evaluateAll(elements=>elements.map(el=>({...el.dataset})));
const settleTiles=async()=>{
  await page.waitForFunction(()=>[...document.querySelectorAll('.cp-map__tile')].every(i=>i.complete),null,{timeout:45000}).catch(()=>{});
  const tiles=await page.locator('.cp-map__tile').evaluateAll(els=>({count:els.length,loaded:els.filter(i=>i.complete&&i.naturalWidth>0).length}));
  expect(tiles.loaded).toBe(tiles.count);return tiles;
};
try {
  await page.goto(baseUrl);
  await page.getByRole('button',{name:'模拟演示',exact:true}).click();
  await page.getByRole('button',{name:'晚间',exact:true}).click();
  await mode('入口实验');
  await page.waitForSelector('.cp-library-light-host[data-model]');
  await page.waitForFunction(() => [...document.querySelectorAll('.cp-library-light-host')]
    .every(el => el.dataset.materialStatus === 'ready' && el.dataset.canopy === 'textured-shared-light'
      && el.dataset.buildingMaterialStatus === 'ready'
      && el.dataset.buildingMaterial === 'generated-linear-rgb-shared-light'
      && el.dataset.pavingMaterialStatus === 'ready'
      && el.dataset.pavingReady === 'true'
      && el.dataset.gisMaterialStatus === 'ready'
      && el.dataset.sourceMaterialReady === 'true'));
  await page.waitForSelector('.cp-lamp-fixtures[data-asset="ready"]');
  checks.push({name:'desktop official tiles',value:await settleTiles()});
  await settings();await page.getByRole('button',{name:/动态演示/}).click();await closeSettings();
  await page.waitForTimeout(300);
  const initial=await datasets('.cp-library-light-host');
  const beforeFrame=initial.map(el=>el.renderFrame);
  await page.waitForTimeout(400);
  expect((await datasets('.cp-library-light-host')).map(el=>el.renderFrame)).toEqual(beforeFrame);
  expect(initial[0].compileMs).toEqual(initial[1].compileMs);
  expect(+initial[0].buildingMaterialPixels).toBeGreaterThan(0);
  expect(+initial[0].groundMaterialPixels).toBeGreaterThan(0);
  const sourcePixels = JSON.parse(initial[0].sourceMaterialPixels);
  expect(sourcePixels.roof).toBeGreaterThan(0);
  expect(sourcePixels.canopy).toBeGreaterThan(0);
  expect(sourcePixels.wall).toBeGreaterThan(0);
  expect(initial[0].canopyDownlightCount).toBe('3');
  expect(initial[0].commonPipeline).toBe('linear-rgb-shared-direct-indirect-facade-additive-room-emission');
  expect(+initial[0].baseDoorPreservedPixels).toBeGreaterThan(0);
  expect(+initial[0].registeredPaneCount).toBe(279);
  expect(+initial[0].facadePixels).toBeGreaterThan(0);
  checks.push({name:'shared atlas and idle renderer',value:initial});
  const actors=await datasets('.cp-activity-layer');
  expect(actors.every(actor=>actor.actorLighting==='library-shared-surface-2.5d')).toBe(true);
  expect(+actors[0].libraryActorCount).toBeGreaterThan(0);
  expect(+actors[0].actorShadowCount).toBeGreaterThan(0);
  expect(+actors[0].actorContactCount).toBeGreaterThan(0);
  checks.push({name:'shared actor materials and shadows',value:actors});
  await page.screenshot({path:out+'final-desktop.png'});
  await page.locator('.detail-scene').screenshot({path:out+'final-detail.png'});
  const transform=()=>page.locator('.cp-map').evaluateAll(maps=>maps.map(map=>{
    const matrix=new DOMMatrixReadOnly(getComputedStyle(map.querySelector('.cp-map__raster')).transform);
    const layer=map.querySelector('.cp-library-light-host');
    return {raster:[matrix.a,matrix.e,matrix.f],overlay:[+layer.dataset.worldScale,+layer.dataset.worldX,+layer.dataset.worldY]};
  }));
  const beforeZoom=await transform();
  await page.locator('.detail-scene .cp-map').focus();
  await page.keyboard.press('+');await page.keyboard.press('ArrowRight');await page.waitForTimeout(250);
  const afterZoom=await transform();
  expect(afterZoom[0]).toEqual(beforeZoom[0]);
  expect(afterZoom[1].raster[0]).toBeGreaterThan(beforeZoom[1].raster[0]);
  // Computed CSS matrices serialize to six significant digits. Allow .02px
  // translation rounding, still far below a visible registration difference.
  for(const map of afterZoom)for(let i=0;i<3;i++)expect(Math.abs(map.raster[i]-map.overlay[i])).toBeLessThan(i===0?.00001:.02);
  checks.push({name:'independent local zoom/pan and raster registration',value:afterZoom});
  await page.locator('.detail-scene .cp-map').press('-');await page.locator('.detail-scene .cp-map').press('ArrowLeft');
  await page.waitForTimeout(250);
  await page.screenshot({path:out+'final-desktop.png'});
  await page.locator('.detail-scene').screenshot({path:out+'final-detail.png'});
  await mode('暖光增强');
  expect(await page.locator('.cp-library-light-host').count()).toBe(0);
  const previous=await datasets('.cp-activity-layer');
  expect(previous.map(el=>el.actorCount)).toEqual(actors.map(el=>el.actorCount));
  expect(previous.every(el=>el.actorLighting==='local-field-2.5d')).toBe(true);
  await page.screenshot({path:out+'final-previous.png'});
  await page.locator('.detail-scene').screenshot({path:out+'final-detail-previous.png'});
  await mode('原始效果');
  expect((await datasets('.cp-activity-layer')).every(el=>el.actorLighting==='original-uniform')).toBe(true);
  await mode('入口实验');
  await settings();await page.getByRole('button',{name:/建筑透视/}).click();await closeSettings();await page.waitForTimeout(250);
  const xray=await page.locator('.cp-library-light-host').evaluateAll(hosts=>hosts.map(host=>Object.fromEntries([...host.querySelectorAll('canvas:not([hidden])')].map(canvas=>[canvas.dataset.libraryChannel,canvas.getContext('2d').globalAlpha]))));
  for(const channels of xray){expect(channels.groundShade).toBe(1);expect(channels.groundDiffuse).toBe(1);expect(channels.groundMaterial).toBe(1);expect(channels.treeMaterial).toBe(1);expect(channels.buildingMaterial).toBeCloseTo(.22,2);expect(channels.buildingFixtureMaterial).toBeCloseTo(.22,2);expect(channels.buildingShade).toBeCloseTo(.22,2);}
  checks.push({name:'building-only xray',value:xray});
  await settings();await page.getByRole('button',{name:/建筑透视/}).click();await closeSettings();
  await page.getByRole('button',{name:'上午',exact:true}).click();await page.waitForTimeout(250);
  expect(await page.locator('.cp-library-light-host').count()).toBe(0);
  expect((await datasets('.cp-activity-layer')).every(el=>el.actorLighting==='day-original')).toBe(true);
  await page.getByRole('button',{name:'晚间',exact:true}).click();await page.waitForSelector('.cp-library-light-host[data-model]');
  await page.getByRole('button',{name:'现场观察',exact:true}).click();await page.waitForTimeout(250);
  expect((await datasets('.cp-activity-layer')).every(el=>el.actorCount==='0')).toBe(true);
  await page.getByRole('button',{name:'模拟演示',exact:true}).click();
  checks.push({name:'comparison/day/field isolation',value:'passed; no submissions or database tests'});
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(700);await settleTiles();
  const mobile=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,canvases:[...document.querySelectorAll('.cp-library-light-host')].map(el=>({...el.dataset}))}));
  expect(mobile.scroll).toBe(mobile.width);
  await page.screenshot({path:out+'final-mobile.png'});
  await settings();
  expect(await page.getByRole('button',{name:'入口实验',exact:true}).isVisible()).toBe(true);
  await page.screenshot({path:out+'final-mobile-settings.png'});await closeSettings();
  checks.push({name:'phone 390x844 and accessible comparison',value:mobile});
  await page.setViewportSize({width:1487,height:1058});await page.waitForTimeout(400);
  await page.locator('.cp-night-lighting[data-renderer="pixi-webgl"]').first().evaluate(canvas=>canvas.dispatchEvent(new Event('webglcontextlost',{cancelable:true})));
  await page.waitForSelector('.cp-night-lighting[data-renderer="canvas-fallback"]');
  expect(await page.locator('.cp-library-light-host[data-model]').count()).toBe(2);
  checks.push({name:'simulated context-loss fallback with local layer retained',value:'passed'});
  expect(errors).toEqual([]);
  const report={checks,errors,warnings};fs.writeFileSync(out+'qa-final.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally {await browser.close();}
