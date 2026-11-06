import {describe,it,expect} from 'vitest';
import {v3StartupFailure,openV3Serial} from '../../src/admin/provisioning/v3-serial.js';
describe('bounded startup diagnostics',()=>{
 it.each([['transport_start','error=263'],['current','error=259'],['control_init','control_result=2'],['recover','']])('accepts only the fixed %s stage', (stage,result)=>{
  const error=v3StartupFailure(`V3 START FAILED stage=${stage}${result?' '+result:''}`);
  expect(error).toMatchObject({code:'v3_device_start_failed',stage});
 });
 it.each(['V3 START FAILED stage=password error=synthetic-secret','V3 START FAILED stage=transport_start error=263 trailing=synthetic-secret','V3 START FAILED stage=current error=9999999999','arbitrary private device output'])('discards unknown/private console output',line=>{
  expect(v3StartupFailure(line)).toBeNull();
 });
 it('keeps the recognized failure queued without logging arbitrary output',async()=>{
  let input;const port={async open(){},async setSignals(){},async close(){},readable:new ReadableStream({start(c){input=c;}}),writable:new WritableStream()};
  const client=await openV3Serial(port);
  input.enqueue(new TextEncoder().encode('V3 START FAILED stage=transport_start error=263\n'));
  // An unsolicited failure cannot become a save result without an accepted START.
  await expect(client.waitStartupSaved(10)).rejects.toThrow('本次未请求保存');await client.close();
 });
});
