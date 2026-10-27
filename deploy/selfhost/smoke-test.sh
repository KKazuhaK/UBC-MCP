#!/usr/bin/env bash
# Exercise the actual hardened image with a disposable volume and synthetic data.
set -euo pipefail
{ set +x; } 2>/dev/null
image="${1:?usage: smoke-test.sh IMAGE}"
name="ubc-connector-smoke-$$"
volume="ubc-connector-smoke-data-$$"
work="$(mktemp -d)"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
  rm -rf -- "$work"
}
trap cleanup EXIT
[ "$(docker run --rm --entrypoint id "$image" -u)" = 10792 ]
docker volume create "$volume" >/dev/null
docker run -d --name "$name" --init --read-only --tmpfs /tmp --cap-drop ALL \
  --security-opt no-new-privileges:true -v "$volume:/data" \
  -e UBC_PUBLIC_ORIGIN=https://hub.example.test "$image" >/dev/null
ready() {
  for ((i=0; i<45; i++)); do
    if docker exec "$name" node -e "fetch('http://127.0.0.1:8792/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then return; fi
    sleep 1
  done
  echo 'Connector did not become healthy' >&2
  exit 1
}
ready
cat > "$work/check.mjs" <<'JS'
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,statSync} from 'node:fs';
import {Store} from '/app/dist/connector/store.js';
const url='http://127.0.0.1:8792',phase=process.argv[2],store=new Store(process.env.UBC_DATA_DIR);
const request=(method,token,body,path='/v1/snapshots',headers={})=>fetch(url+path,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
if(phase==='seed') {
  const a=store.create('Synthetic smoke A'),b=store.create('Synthetic smoke B');
  assert.equal((await request('GET')).status,401);
  assert.equal((await request('GET',a.uploadToken)).status,401);
  assert.equal((await request('POST',a.readToken,{})).status,401);
  const capturedAt=new Date().toISOString();
  const section={id:'ZZTEST-999-001',subject:'ZZTEST',course:'999',code:'ZZTEST_V 999 001',title:'Synthetic deployment acceptance',activity:'lecture',instructors:[],registrationStatusRaw:'Open',capacity:10,enrolled:1,seatsAvailable:9,waitlistCapacity:null,waitlistCount:null,reservedSeatsAvailable:null,restrictions:null,scheduleKind:'unknown',meetings:[],allowedCompanionIds:null,requiredActivities:null,observedAt:capturedAt};
  const snapshot={schemaVersion:1,kind:'sections',campus:'UBCV',academicPeriod:{id:'2026W-SMOKE',label:'Synthetic smoke',yearSession:'2026W',term:'1'},capturedAt,source:'workday-export',coverage:{subjects:['ZZTEST'],complete:false},sections:[section],enrollments:null};
  assert.equal((await request('POST',a.uploadToken,snapshot)).status,200);
  assert.equal((await request('POST',a.uploadToken,snapshot)).status,400);
  assert.deepEqual(await (await request('GET',b.readToken)).json(),[]);
  const data=await (await request('GET',a.readToken)).json();
  assert.equal(data[0].capturedAt,capturedAt);
  assert.equal(data[0].sections[0].title,section.title);
  assert.equal((await request('GET',null,null,'/ubc/')).status,200);
  assert.equal((await request('GET',null,null,'/ubc/api/status')).status,403);
  const preflight=await request('OPTIONS',null,null,'/ubc/api/claim',{Origin:'moz-extension://12345678-1234-1234-1234-123456789abc'});
  assert.equal(preflight.status,204);
  assert.equal(statSync(process.env.UBC_DATA_DIR+'/encryption.key').mode & 0o777,0o600);
  writeFileSync('/data/smoke.json',JSON.stringify({a,b,capturedAt}),{mode:0o600});
} else {
  const {a,b,capturedAt}=JSON.parse(readFileSync('/data/smoke.json','utf8'));
  assert.equal((await (await request('GET',a.readToken)).json())[0].capturedAt,capturedAt);
  store.revoke(a.id);
  assert.equal((await request('GET',a.readToken)).status,401);
  assert.equal((await request('POST',a.uploadToken,{})).status,401);
  assert.deepEqual(await (await request('GET',b.readToken)).json(),[]);
  store.revoke(b.id);
}
store.close();
console.log('ok: '+phase);
JS
docker cp "$work/check.mjs" "$name:/tmp/check.mjs"
docker exec "$name" node /tmp/check.mjs seed
docker restart "$name" >/dev/null
ready
# /tmp is intentionally ephemeral after a restart.
docker cp "$work/check.mjs" "$name:/tmp/check.mjs"
docker exec "$name" node /tmp/check.mjs restored
echo 'PASS: non-root read-only image, access scopes, user isolation, snapshot persistence and revocation'
