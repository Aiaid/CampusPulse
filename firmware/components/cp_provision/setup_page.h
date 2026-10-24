#pragma once
/* ASCII-only local page; no third-party assets, cloud fetches or storage. */
static const char CP_SETUP_HEAD[] =
"<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>CampusPulse local setup</title>"
"<style>body{font:17px system-ui;max-width:35rem;margin:2rem auto;padding:1rem;background:#f4f7fa;color:#102437}label{display:block;margin:1rem 0}input,textarea,button{box-sizing:border-box;width:100%;padding:.8rem;font:inherit}button{background:#075e64;color:white;border:0}pre{white-space:pre-wrap}</style>"
"<h1>CampusPulse local setup</h1><p>Factory node: <strong id=node>";
static const char CP_SETUP_MID[] =
"</strong></p><p>This page runs on your device. Keep connected to its password-protected Wi-Fi. Only WPA2 personal networks are supported; enterprise/PEAP is not supported.</p>"
"<form id=f autocomplete=off><label>Setup proof shown on device<input name=proof type=password required minlength=32 maxlength=32 pattern='[a-fA-F0-9]{32}' autocomplete=off></label>"
"<label>Cloud enrollment handoff from the administrator page<textarea name=handoff rows=5 required spellcheck=false autocomplete=off></textarea></label>"
"<label>Target Wi-Fi SSID<input name=ssid required maxlength=32 autocomplete=off></label>"
"<label>Target Wi-Fi password<input name=password type=password required minlength=8 maxlength=63 autocomplete=new-password></label>"
"<button>Submit to this device</button></form><pre id=status role=status></pre>"
"<script>const nonce='";
static const char CP_SETUP_END[] =
"';let busy=false;document.querySelector('#f').onsubmit=async(e)=>{e.preventDefault();if(busy)return;const f=e.target,s=document.querySelector('#status');let h;try{h=JSON.parse(f.handoff.value);if(h.v!==1||h.node_id!==document.querySelector('#node').textContent||!/^cpd_[a-f0-9]{64}$/.test(h.device_token)||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(h.attempt_id))throw Error();}catch{s.textContent='Invalid handoff or wrong factory node. Return to the administrator page.';return;}busy=true;f.querySelector('button').disabled=true;s.textContent='Sending candidate settings...';try{const r=await fetch('/configure',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({v:1,op:'configure',nonce,proof:f.proof.value.toLowerCase(),node_id:h.node_id,device_token:h.device_token,attempt_id:h.attempt_id,ssid:f.ssid.value,password:f.password.value})});const a=await r.json();if(!a.ok)throw Error(a.reason||'Device rejected settings');f.reset();s.textContent='Received by device; network validation is still pending. The setup hotspot will stop. Check the device screen and reconnect to your normal network, then return to the administrator page to check cloud contact and configuration ACK.';}catch{busy=false;f.querySelector('button').disabled=false;s.textContent='No confirmation received. Check the device screen and cloud status before retrying. Do not rotate the cloud credential merely because this response was lost.';}finally{h=null;}};window.addEventListener('pagehide',()=>document.querySelector('#f').reset());</script></html>";
