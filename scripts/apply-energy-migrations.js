#!/usr/bin/env node
'use strict';
// Applies only the audited additive energy migrations, never unrelated pending
// catalogue entries or the retired historical reset. Explicit connection only.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {Pool}=require('pg');
const {run,sha}=require('./migrate');
const files=['064_energy_interval_pipeline.sql','065_energy_continuous_aggregates.sql'];
async function apply(pool,{write=false,log=console}={}) {
  const prerequisite='063_sparse_energy_observations.sql';
  const root=path.join(__dirname,'../src/migrations');
  const {rows:[prior]}=await pool.query('SELECT checksum FROM schema_migrations WHERE filename=$1',[prerequisite]);
  if(prior?.checksum!==sha(fs.readFileSync(path.join(root,prerequisite),'utf8')))throw Error('Migration 063 must be applied with its verified checksum first');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'energy-schema-'));
  try {
    for(const file of files)fs.copyFileSync(path.join(root,file),path.join(dir,file));
    return await run(pool,{dir,args:write?[]:['--dry'],log});
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
module.exports={apply,files};
if(require.main===module){
  if(process.argv.slice(2).some(a=>a!=='--apply')){console.error('Only --apply is accepted; default is a read-only preview');process.exit(1);}
  if(!process.env.ENERGY_DATABASE_URL){console.error('Set ENERGY_DATABASE_URL explicitly');process.exit(1);}
  const pool=new Pool({connectionString:process.env.ENERGY_DATABASE_URL,max:1,
    application_name:'energy-schema-migration',statement_timeout:120000,lock_timeout:5000});
  apply(pool,{write:process.argv.includes('--apply')}).then(code=>{process.exitCode=code;})
    .catch(error=>{console.error(error.code||error.message);process.exitCode=1;}).finally(()=>pool.end());
}
