const test=require('node:test');
const assert=require('node:assert/strict');
const {agentPayload,agentRemoteCommand}=require('../agent-lifecycle');
test('restricted lifecycle transport allows no caller commands/env and preserves custom ports',()=>{
 const p=agentPayload({action:'inspect',projectDir:'/srv/project',installDir:'/srv/agent',mode:'worker_telemetry',workerId:'worker',host:'127.0.0.2',port:23065,command:'kill all',env:{SECRET:'do not send'}});
 assert.equal(p.port,23065);assert.ok(!('command'in p));assert.ok(!('env'in p));
 assert.throws(()=>agentPayload({...p,action:'kill'}),/AGENT_ACTION_INVALID/);
 assert.throws(()=>agentPayload({...p,installDir:'/srv/../agent'}),/AGENT_PATH_INVALID/);
 assert.throws(()=>agentPayload({...p,action:'restart'}),/AGENT_RUNTIME_PROOF_REQUIRED/);
 assert.throws(()=>agentPayload({...p,action:'migrate'}),/AGENT_MIGRATION_CONFIRM_REQUIRED/);
 const migration=agentPayload({...p,action:'migrate',migrationDigest:'a'.repeat(64),signal:'SIGKILL'});
 assert.equal(migration.migrationDigest,'a'.repeat(64));assert.ok(!('signal'in migration));
 assert.match(agentRemoteCommand(),/^python3 -c /);
});
