import { encryptMqttPassword, type MqttRow } from '../../worker/mqtt-credentials';
import type { State } from '../admin-auth-helpers';
export const MQTT_TEST_KEY='BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';
export async function seedMqtt(state:State,number=1,node:string|null=null):Promise<MqttRow[]> {
 state.env.MQTT_PROVISIONING_KEY=MQTT_TEST_KEY;
 const rows=[];
 for(let i=0;i<number;i++) {
  const user=`qa${crypto.randomUUID().replaceAll('-','').slice(0,12)}`;
  const row:MqttRow={id:crypto.randomUUID(),username:user,namespace:user,password_ciphertext:'',state:node?'assigned':'ready',node_id:node,created_at:new Date().toISOString(),verified_at:new Date().toISOString(),verification_error:null};
  row.password_ciphertext=await encryptMqttPassword(state.env,row,'synthetic-mqtt-password-only-for-tests');
  state.db.prepare('INSERT INTO mqtt_credentials(id,username,namespace,password_ciphertext,state,node_id,created_at,verified_at) VALUES(?,?,?,?,?,?,?,?)').run(row.id,row.username,row.namespace,row.password_ciphertext,row.state,row.node_id,row.created_at,row.verified_at);
  rows.push(row);
 }
 return rows;
}
