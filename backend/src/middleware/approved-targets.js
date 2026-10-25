/** Minimal public-demo spending guard; not a replacement for per-user production quotas. */
export function requireApprovedTargets(env = process.env, repos = null) {
  const allowed = String(env.ALLOWED_TEST_HOSTS ?? '').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
  const quota = Math.min(200,Math.max(1,Number.parseInt(env.MAX_TESTS_PER_HOUR ?? '20',10)||20));
  const ledger=new Map();
  return (req,res,next)=>{
    if(req.method !== 'POST')return next();
    const isRun=req.path === '/executions';
    const contractMatch=req.path.match(/^\/contracts\/([a-zA-Z0-9-]+)\/executions$/);
    if(!isRun && !contractMatch)return next();

    // For production, only perform automation on explicitly approved HTTPS targets.
    let requested = isRun ? req.body?.url : null;
    if(contractMatch){
      const saved = repos?.contracts?.get(contractMatch[1]);
      requested=saved?.url;
    }
    if(typeof requested === 'string' && requested.length){
      let url;
      try { url=new URL(requested); } catch {return res.status(400).json({error:'Invalid target URL'});}
      if((env.NODE_ENV === 'production' || allowed.length > 0) && (url.protocol!=='https:'||url.username||url.password||!allowed.includes(url.hostname.toLowerCase()))){
        return res.status(403).json({error:'Test target is not in ALLOWED_TEST_HOSTS'});
      }
    } else if(env.NODE_ENV === 'production' && contractMatch){
      return res.status(403).json({error:'Contract has no allowlisted URL'});
    }
    // Built-in, fixed public sample scenarios don't supply a URL; all executions count toward quota.
    const now=Date.now();
    if(ledger.size>5000){for(const [k,v] of ledger)if(v.reset<now)ledger.delete(k);}
    const key='shared-demo';
    const current=ledger.get(key);
    const nextCount = !current||current.reset<now ? {count:1,reset:now+3600000} : {count:current.count+1,reset:current.reset};
    ledger.set(key,nextCount);
    if(nextCount.count>quota) return res.status(429).json({error:'Test quota reached for this hour'});
    next();
  };
}

