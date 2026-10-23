import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { X509Certificate, createHash } from 'node:crypto';

// Local Worker only: synthetic records are soft-cancelled after acceptance.
const baseURL = process.env.SMOKE_URL || 'http://127.0.0.1:8787';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname), 'Local target required');
const token = readFileSync('.dev.vars', 'utf8').match(/^OPERATOR_TOKEN=(.+)$/m)?.[1];
assert.ok(token, 'Set a local .dev.vars OPERATOR_TOKEN first');
const args = ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
if (process.env.NODE_EXTRA_CA_CERTS) {
  const ca = new X509Certificate(readFileSync(process.env.NODE_EXTRA_CA_CERTS));
  const spki = createHash('sha256').update(ca.publicKey.export({type:'spki',format:'der'})).digest('base64');
  args.push(`--ignore-certificate-errors-spki-list=${spki}`);
}
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || (existsSync(chromium.executablePath()) ? chromium.executablePath() : '/usr/bin/chromium'),
  headless: true, args,
  proxy: process.env.HTTPS_PROXY ? {server:process.env.HTTPS_PROXY,bypass:'localhost,127.0.0.1'} : undefined,
});
try {
  const page = await browser.newPage({viewport:{width:1487,height:1058}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  if (process.env.SMOKE_GIS === 'offline') await page.route('https://gis.ccnu.edu.cn/mapdata/**', route => route.abort());
  await page.goto(baseURL);
  await page.getByRole('heading',{name:'图书馆',exact:true}).waitFor();
  assert.equal(await page.locator('.cp-map').count(), 2, 'Overview and independent local map');
  if (process.env.SMOKE_GIS === 'offline') {
    await page.locator('.overview-map .cp-map__tile-notice').waitFor();
  } else {
    await page.waitForFunction(() => [...document.querySelectorAll('.overview-map .cp-map__tile')].some(i => i.complete && i.naturalWidth > 0));
  }
  await page.waitForFunction(() => [...document.querySelectorAll('.cp-activity-layer')].every(c => Number(c.dataset.actorCount) > 0));
  await page.getByRole('button',{name:'上午',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('main').classList.contains('light') && [...document.querySelectorAll('.cp-night-lighting')].every(c => c.dataset.lampCount === '0'));
  await page.getByRole('button',{name:'晚间',exact:true}).click();
  await page.getByRole('button',{name:'场景设置',exact:true}).click();
  await page.getByRole('button',{name:'原始效果',exact:true}).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.cp-night-lighting')].every(c => c.dataset.lightingMode === 'original'));
  await page.getByRole('button',{name:'暖光增强',exact:true}).click();
  await page.getByRole('button',{name:'动态演示 仅控制人物与骑乘车辆的移动',exact:true}).click();
  await page.getByRole('button',{name:'建筑透视 淡化楼体，查看后方活动示意',exact:true}).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.cp-activity-layer')].every(c => c.dataset.xray === 'true' && c.dataset.motion === 'paused'));
  await page.getByRole('button',{name:'关闭场景设置',exact:true}).click();
  await page.getByRole('button',{name:'电动车活动',exact:true}).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.cp-activity-layer')].every(c => c.dataset.ridingCount === '0' && c.dataset.parkedCount === '0' && Number(c.dataset.personCount) > 0));
  await page.getByRole('button',{name:'电动车活动',exact:true}).click();
  await page.getByRole('button',{name:'候梯',exact:true}).click();
  assert.equal(await page.locator('.cp-map__wait').count(), 0);
  await page.getByRole('button',{name:'候梯',exact:true}).click();
  await page.getByRole('textbox',{name:'搜索建筑或地点',exact:true}).fill('八号');
  await page.getByRole('textbox',{name:'搜索建筑或地点',exact:true}).press('Enter');
  await page.getByRole('heading',{name:'八号教学楼',exact:true}).waitFor();
  await page.getByRole('button',{name:'查看时段变化',exact:true}).click();
  await page.getByRole('heading',{name:'这个地点，一天的变化',exact:true}).waitFor();
  await page.getByRole('button',{name:'返回局部视图',exact:true}).first().click();
  await page.getByRole('button',{name:'现场观察',exact:true}).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.cp-activity-layer')].every(c => c.dataset.actorCount === '0'));
  assert.equal(await page.locator('.cp-map__wait').count(), 0, 'No simulated waits in field mode');
  assert.equal(await page.getByRole('button',{name:'播放时段回放',exact:true}).isDisabled(), true);

  await page.getByRole('button',{name:'现场记录',exact:true}).click();
  const dialog = page.getByRole('dialog',{name:'现场观察与记录',exact:true});
  await dialog.getByRole('combobox',{name:'记录地点',exact:true}).selectOption('east-parking');
  await dialog.getByRole('spinbutton',{name:'最少（辆）',exact:true}).fill('2');
  await dialog.getByRole('spinbutton',{name:'最多（辆）',exact:true}).fill('5');
  await dialog.getByLabel('操作员凭据',{exact:true}).fill(token);
  const posted = page.waitForResponse(r => r.url().endsWith('/api/v1/observations') && r.request().method() === 'POST');
  await dialog.getByRole('button',{name:'提交并确认',exact:true}).click();
  const response = await posted;
  assert.equal(response.status(), 201);
  const receipt = await response.json();
  assert.equal(receipt.durability, 'committed');
  await dialog.getByText('记录已获服务端确认',{exact:true}).waitFor();
  await dialog.locator('.observation-value strong').filter({hasText:'2–5 辆'}).waitFor();
  const cancelled = page.waitForResponse(r => r.url().endsWith(`/observations/${receipt.observation.id}`) && r.request().method() === 'DELETE');
  await dialog.getByRole('button',{name:'撤销最近一条记录',exact:true}).click();
  assert.equal((await cancelled).status(), 200);
  await dialog.getByText('记录已撤销，服务端已确认',{exact:true}).waitFor();
  await dialog.getByRole('button',{name:'关闭记录表单',exact:true}).click();
  await page.getByRole('button',{name:'模拟演示',exact:true}).click();
  await page.getByRole('button',{name:'晚间',exact:true}).click();
  mkdirSync('/tmp/campuspulse-qa',{recursive:true});
  await page.screenshot({path:'/tmp/campuspulse-qa/desktop.png'});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow');
  await page.getByRole('button',{name:'收起局部详情',exact:true}).click();
  await page.locator('.reopen-detail').click();
  await page.getByRole('button',{name:'现场记录',exact:true}).click();
  await page.getByRole('dialog',{name:'现场观察与记录',exact:true}).waitFor();
  await page.getByRole('button',{name:'关闭记录表单',exact:true}).click();
  await page.screenshot({path:'/tmp/campuspulse-qa/mobile.png'});
  assert.deepEqual(errors, [], 'Browser runtime errors');
  console.log('Browser smoke passed: registered GIS/fallback, retained Oct21 interactions, light comparison, field/demo separation, local D1 submit/cancel, phone layout.');
} finally { await browser.close(); }
