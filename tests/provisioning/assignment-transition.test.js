import {describe,it,expect} from 'vitest';
import {withAssignmentTransition} from '../../src/admin/provisioning/assignment-transition.js';
const receipt=Object.freeze({protocol:'campuspulse/3',node_id:'synthetic-node',assignment_generation:2,policy_sha256:'a'.repeat(64),state:'assigned',applied:false,requires_device_ack:true});
const headers=(before='1',after='2',revoked='1')=>new Headers({'X-CP-Startup-Revision-Before':before,'X-CP-Startup-Revision-After':after,'X-CP-Startup-Revoked':revoked});
describe('assignment transaction hints',()=>{
 it('normalizes only the exact committed transition and preserves the receipt',()=>{
  expect(withAssignmentTransition(receipt,headers())).toEqual({...receipt,startup_grant_revision_before:1,startup_grant_revision_after:2,startup_grant_revoked:true});
  expect(withAssignmentTransition(receipt,headers('0','0','0'))).toEqual({...receipt,startup_grant_revision_before:0,startup_grant_revision_after:0,startup_grant_revoked:false});
  expect(receipt).not.toHaveProperty('startup_grant_revision_before');
 });
 it('does not invent transition evidence from a retained retry or wire JSON fields',()=>{
  expect(withAssignmentTransition(receipt,new Headers())).toEqual(receipt);
  expect(withAssignmentTransition({...receipt,startup_grant_revision_before:1,startup_grant_revision_after:2,startup_grant_revoked:true},new Headers())).toEqual(receipt);
 });
 it.each([['-1','0','1'],['01','2','1'],['9007199254740992','9007199254740993','1'],['1','3','1'],['1','2','0'],['1','2','true']])('rejects malformed or inconsistent revision hints %s %s %s',(...args)=>{
  expect(()=>withAssignmentTransition(receipt,headers(...args))).toThrow();
 });
 it('rejects partial hints or a non-assignment result',()=>{
  expect(()=>withAssignmentTransition(receipt,new Headers({'X-CP-Startup-Revision-Before':'1'}))).toThrow();
  expect(()=>withAssignmentTransition({...receipt,applied:true},headers())).toThrow();
 });
});
