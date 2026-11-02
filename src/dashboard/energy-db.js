'use strict';
const db=require('../db');
function createLimiter({max=4,maxQueued=100,waitMs=5000}={}) {
  let active=0;
  const queue=[];
  const busy=()=>Object.assign(new Error('Energy reports are busy. Please try again shortly.'),{status:503});
  function acquire() {
    if(active<max){active++;return Promise.resolve(release);}
    if(queue.length>=maxQueued)return Promise.reject(busy());
    return new Promise((resolve,reject)=>{
      const item={resolve,reject,timer:null};
      item.timer=setTimeout(()=>{
        const at=queue.indexOf(item);if(at>=0)queue.splice(at,1);
        reject(busy());
      },waitMs);
      queue.push(item);
    });
  }
  function release() {
    const item=queue.shift();
    if(item){clearTimeout(item.timer);item.resolve(release);}else active--;
  }
  return async function limited(work) {
    // Awaiting preserves the caller's authorization/read-only async context;
    // do not invoke the next work callback from a different request's release.
    const done=await acquire();
    try{return await work();}finally{done();}
  };
}
const requested=Number(process.env.DB_ENERGY_QUERY_MAX||4);
const configuredPool=Number(process.env.DB_POOL_MAX||20);
const poolMax=Number.isInteger(configuredPool)&&configuredPool>0?configuredPool:20;
const max=Number.isInteger(requested)&&requested>0?Math.min(requested,Math.max(1,poolMax-4),16):4;
const limit=createLimiter({max});
module.exports={query:(...args)=>limit(()=>db.query(...args)),createLimiter};
