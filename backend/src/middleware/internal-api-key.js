import { timingSafeEqual } from 'node:crypto';
/** Only server-to-server requests with the shared private key reach expensive APIs. */
export function requireInternalKey(env = process.env) {
  const required = String(env.FLOWFIX_INTERNAL_API_KEY ?? '');
  return (req,res,next) => {
    if(req.method === 'GET' && req.path === '/health') return next();
    if(!required){
      if(env.NODE_ENV === 'production') return res.status(503).json({error:'FLOWFIX_INTERNAL_API_KEY not configured'});
      return next(); // local dev only
    }
    const given=String(req.get('x-flowfix-internal-key') ?? '');
    const a=Buffer.from(given), b=Buffer.from(required);
    if(a.length !== b.length || !timingSafeEqual(a,b)) return res.status(401).json({error:'Not authorized'});
    return next();
  };
}

