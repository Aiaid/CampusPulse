/** Transaction-only hints stay in headers so immutable assignment receipt JSON
 * remains identical on exact retries. A retry has no implied grant transition. */
export function withAssignmentTransition(receipt,headers) {
 if(!receipt||typeof receipt!=='object'||Array.isArray(receipt))throw new Error('策略回执无效，请刷新核对。');
 const result={...receipt};
 for(const key of ['startup_grant_revision_before','startup_grant_revision_after','startup_grant_revoked'])delete result[key];
 const before=headers.get('X-CP-Startup-Revision-Before'),after=headers.get('X-CP-Startup-Revision-After'),revoked=headers.get('X-CP-Startup-Revoked');
 if(before===null&&after===null&&revoked===null)return result;
 const integer=value=>typeof value==='string'&&/^(0|[1-9][0-9]{0,15})$/.test(value)&&Number.isSafeInteger(Number(value));
 if(!integer(before)||!integer(after)||!['0','1'].includes(revoked)||Number(after)!==Number(before)+(revoked==='1'?1:0)||
    receipt.protocol!=='campuspulse/3'||receipt.state!=='assigned'||receipt.applied!==false||receipt.requires_device_ack!==true||
    !Number.isSafeInteger(receipt.assignment_generation)||receipt.assignment_generation<1||typeof receipt.node_id!=='string'||
    !/^[a-f0-9]{64}$/.test(receipt.policy_sha256||''))throw new Error('服务端未确认本次策略发布的授权版本变化；请刷新后手动核对，不会自动重试。');
 return {...result,startup_grant_revision_before:Number(before),startup_grant_revision_after:Number(after),startup_grant_revoked:revoked==='1'};
}
