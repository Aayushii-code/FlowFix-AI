'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  Activity, ArrowRight, ArrowUpRight, Bot, CheckCircle2, ChevronDown,
  CircleHelp, ClipboardCheck, Code2, Database, FileCheck2, Fingerprint,
  Github, Layers, LayoutDashboard, Menu, MonitorCheck, Moon, Network,
  Play, RefreshCw, SearchCheck, ShieldCheck, ShoppingCart, Sparkles,
  Sun, Workflow, X, Zap,
} from 'lucide-react';

type ExecutionSummary = {execution_id:string; url?:string; status:string; verification?:{verdict?:string|null}; created_at?:string};
type CapabilityData = {tinyfish?:{configured?:boolean};verification?:{engine?:string};persistence?:{kind?:string}};

const features = [
  {icon:RefreshCw,title:'Regression testing',desc:'Run real browser journeys repeatedly with explicit expected results.',href:'/tests/new',state:'Available for manual runs'},
  {icon:ShoppingCart,title:'E-commerce assurance',desc:'Verify product, variant, price, coupon and order snapshots.',href:'/commerce',state:'Sandbox verification'},
  {icon:Network,title:'Cross-system verification',desc:'Compare browser, REST and read-only SQL evidence.',href:'/cross-system',state:'REST + SQLite supported'},
  {icon:MonitorCheck,title:'Business process monitoring',desc:'Track execution history and platform status. Automated scheduling is planned.',href:'/history',state:'Schedules planned'},
  {icon:Bot,title:'AI agent assurance',desc:'Inspect automation outcomes without treating agent success as verified truth.',href:'/history',state:'Browser agents supported'},
  {icon:Workflow,title:'RPA quality assurance',desc:'Extend FlowFix with bot-run evidence and output reconciliation.',href:'/integrations',state:'Connector planned'},
  {icon:ClipboardCheck,title:'Compliance evidence',desc:'Review versioned contracts, audit events and evidence provenance.',href:'/audit',state:'Evidence audit available'},
  {icon:Zap,title:'Failure diagnosis',desc:'Read root-cause classifications and next steps for failed executions.',href:'/history',state:'Auto-repair planned'},
  {icon:Sparkles,title:'Requirement compiler',desc:'Convert natural-language requirements into checks that you can review.',href:'/tests/new',state:'Deterministic compiler'},
  {icon:Layers,title:'Digital employee assurance',desc:'A unified view for task-driven agent fleets as connectors are added.',href:'/integrations',state:'Fleet monitoring planned'},
] as const;

const faq = [
  {q:'Does FlowFix actually execute browser tests?',a:'Yes. When TinyFish is configured, FlowFix sends real browser journeys to the provider. It keeps execution status separate from the independent verification verdict.'},
  {q:'Does a completed run automatically count as PASS?',a:'No. A PASS requires sufficient independently obtained evidence. Missing evidence yields INCONCLUSIVE, not an invented success.'},
  {q:'Can I verify a real e-commerce order?',a:'The current commerce rules verify a supplied staging/sandbox transaction snapshot. Live order-provider integration and payment-safe workflows are a separate implementation stage.'},
  {q:'Can I connect databases and APIs?',a:'REST requests and restricted read-only SQLite checks are implemented. Production CRM, email, ERP and broader SQL drivers require additional connectors and access controls.'},
  {q:'Is automatic self-healing available today?',a:'Not yet. FlowFix provides diagnoses and suggested actions. Automatic fixes should only be added after isolated tests, explicit approval and rollback safeguards.'},
];

function LivePreview() {
  const [runs,setRuns]=useState<ExecutionSummary[]>([]);
  const [caps,setCaps]=useState<CapabilityData|null>(null);
  const [loading,setLoading]=useState(true);
  const [connected,setConnected]=useState(false);
  useEffect(()=>{
    let active=true;
    Promise.allSettled([
      fetch('/api/platform/executions?limit=4',{cache:'no-store'}).then(async r=>{if(!r.ok)throw new Error('Unavailable');return r.json();}),
      fetch('/api/platform/capabilities',{cache:'no-store'}).then(async r=>{if(!r.ok)throw new Error('Unavailable');return r.json();}),
    ]).then(([a,b])=>{
      if(!active)return;
      if(a.status==='fulfilled' && Array.isArray(a.value.executions)) {setRuns(a.value.executions);setConnected(true);}
      if(b.status==='fulfilled'){setCaps(b.value as CapabilityData);setConnected(true);}
    }).finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[]);
  return <div className="cd-product-window" aria-label="FlowFix application preview with live backend status">
    <div className="cd-window-head"><span className="cd-dot"/><span className="cd-dot"/><span className="cd-dot"/><div className="cd-window-title"><ShieldCheck size={13}/> flowfix.ai / assurance workspace</div><span className="cd-win-live">{loading?'Connecting...':connected?'Backend connected':'Connect backend to view live data'}</span></div>
    <div className="cd-window-content">
      <div className="cd-mock-sidebar"><span className="cd-side-logo"><Zap size={16}/> FlowFix</span><div className="cd-side-row cd-active"><LayoutDashboard size={14}/> Overview</div><div className="cd-side-row"><SearchCheck size={14}/> Test builder</div><div className="cd-side-row"><FileCheck2 size={14}/> Contracts</div><div className="cd-side-row"><Activity size={14}/> Run history</div><div className="cd-side-row"><Database size={14}/> Integrations</div><div className="cd-sidebar-note"><span/> Verification workspace</div></div>
      <div className="cd-mock-content">
        <div className="cd-mock-title"><div><span>OVERVIEW</span><h3>Assurance dashboard</h3><p>Execution facts. Independently verified outcomes.</p></div><Link href="/tests/new" className="cd-mock-new"><span>+</span> New test</Link></div>
        <div className="cd-mock-stats">
          <div><span>Recent runs</span><strong>{loading?'â€”':connected?runs.length:'â€”'}</strong><small>From backend</small></div>
          <div><span>Verified PASS</span><strong>{loading?'â€”':connected?runs.filter(x=>x.verification?.verdict==='PASS').length:'â€”'}</strong><small>Evidence based</small></div>
          <div><span>Running now</span><strong>{loading?'â€”':connected?runs.filter(x=>['QUEUED','RUNNING'].includes(x.status)).length:'â€”'}</strong><small>Live execution state</small></div>
        </div>
        <div className="cd-mock-table"><div className="cd-mock-table-head"><b>Latest executions</b><Link href="/history">View history <ArrowUpRight size={12}/></Link></div>
          {runs.length ? runs.slice(0,3).map((r)=><div className="cd-mock-table-row" key={r.execution_id}><span className="cd-iconbox"><Code2 size={15}/></span><span className="cd-run-target"><strong>{r.url ? (()=>{try{return new URL(r.url).hostname}catch{return 'Website test'}})() : 'Website test'}</strong><small>Run {r.execution_id.slice(0,8)}</small></span><span className="cd-run-verdict">{r.verification?.verdict ?? r.status}</span></div>) : <div className="cd-no-runs"><SearchCheck size={18}/>{loading?'Loading actual runs...':connected?'No executions yet. Create your first real test.':'Backend unavailable â€” no demo results are invented.'}</div>}
        </div><div className="cd-preview-footer"><ShieldCheck size={14}/><span>Verifier: {caps?.verification?.engine??'not available'}</span><span>Storage: {caps?.persistence?.kind??'not available'}</span></div>
      </div>
    </div>
  </div>;
}

export default function Home(){
  const [dark,setDark]=useState(false);
  const [menu,setMenu]=useState(false);
  return <div className={`cd-site ${dark?'cd-dark':''}`}>
    <header className="cd-header"><div className="cd-container cd-nav">
      <Link href="/" className="cd-logo"><span><Zap size={19} fill="currentColor"/></span>FlowFix<span className="cd-logo-accent">AI</span></Link>
      <nav className={`cd-nav-links ${menu?'cd-open':''}`} aria-label="Site navigation"><a onClick={()=>setMenu(false)} href="#features">Features</a><a onClick={()=>setMenu(false)} href="#how">How it works</a><a onClick={()=>setMenu(false)} href="#architecture">Platform</a><a onClick={()=>setMenu(false)} href="#faq">FAQ</a></nav>
      <div className="cd-nav-acts"><button type="button" aria-label={dark?'Use light theme':'Use dark theme'} className="cd-theme-toggle" onClick={()=>setDark(x=>!x)}>{dark?<Sun size={18}/>:<Moon size={18}/>}</button><Link className="cd-nav-login" href="/workspace">Dashboard</Link><Link className="cd-btn cd-btn-primary cd-nav-cta" href="/tests/new">Get started <ArrowRight size={15}/></Link><button type="button" className="cd-mobile-menu" onClick={()=>setMenu(v=>!v)} aria-label="Toggle navigation">{menu?<X size={21}/>:<Menu size={21}/>}</button></div>
    </div></header>

    <main>
      <section className="cd-hero cd-container">
        <div className="cd-hero-top"><span className="cd-trust"><span className="cd-trust-icons"><ShieldCheck size={15}/></span> Evidence-led AI workflow assurance <span className="cd-trust-star">âœ¦</span></span></div>
        <h1>Know your workflows<br/><span>actually work.</span></h1>
        <p className="cd-hero-description">Turn business requirements into real browser tests. Collect proof, catch silent failures, and understand what brokeâ€”without mistaking a completed click for a correct outcome.</p>
        <div className="cd-hero-buttons"><Link className="cd-btn cd-btn-primary cd-btn-large" href="/tests/new">Start verifying <ArrowRight size={17}/></Link><Link className="cd-btn cd-btn-outline cd-btn-large" href="/workspace"><LayoutDashboard size={17}/> Open workspace</Link></div>
        <div className="cd-hero-trustline"><span><CheckCircle2 size={14}/> Real TinyFish execution</span><span><CheckCircle2 size={14}/> Independent checks</span><span><CheckCircle2 size={14}/> Evidence & audit trail</span></div>
        <LivePreview/>
      </section>

      <section className="cd-proof-strip"><div className="cd-container"><span>BUILT FOR ASSURANCE ACROSS</span><div><strong><MonitorCheck size={20}/> Websites</strong><strong><Database size={20}/> Data APIs</strong><strong><ShoppingCart size={20}/> Commerce</strong><strong><Bot size={20}/> AI workflows</strong><strong><Fingerprint size={20}/> Compliance</strong></div></div></section>

      <section id="features" className="cd-section cd-container"><span className="cd-eyebrow">FEATURES</span><h2>Everything you need to<br/>verify with confidence.</h2><p className="cd-section-lead">A single workspace for browser execution, independent checks and traceable business outcomes. Capabilities that are still under development are clearly labeled.</p>
        <div className="cd-features">{features.map((f,i)=><Link href={f.href} className="cd-feature" key={f.title}><div className="cd-feature-top"><span className="cd-feature-icon"><f.icon size={21}/></span><span className="cd-feature-num">{String(i+1).padStart(2,'0')}</span></div><h3>{f.title}</h3><p>{f.desc}</p><div className="cd-feature-end"><span>{f.state}</span><ArrowUpRight size={17}/></div></Link>)}</div>
      </section>

      <section id="how" className="cd-section cd-alt"><div className="cd-container"><span className="cd-eyebrow">HOW IT WORKS</span><h2>From requirement to<br/>reliable evidence.</h2><p className="cd-section-lead">Make the entire verification journey transparent. No fabricated metrics, statuses or screenshots.</p>
        <div className="cd-how-grid">{[
          {n:'01',icon:FileCheck2,t:'Describe',d:'Define the actual business outcome in plain language.'},
          {n:'02',icon:Play,t:'Execute',d:'TinyFish visits the authorized site and performs the journey.'},
          {n:'03',icon:Layers,t:'Collect',d:'Capture returned evidence and independently query trusted sources.'},
          {n:'04',icon:ShieldCheck,t:'Verify',d:'Evaluate explicit checks as PASS, FAIL or INCONCLUSIVE.'},
          {n:'05',icon:SearchCheck,t:'Understand',d:'Inspect the run, root cause, timestamps and next actions.'},
        ].map(step=><div className="cd-how-step" key={step.n}><div className="cd-step-top"><step.icon size={21}/><span>{step.n}</span></div><h3>{step.t}</h3><p>{step.d}</p></div>)}</div>
        <Link className="cd-btn cd-btn-primary" href="/tests/new">Create a real verification <ArrowRight size={16}/></Link>
      </div></section>

      <section id="architecture" className="cd-section cd-container cd-arch-grid"><div><span className="cd-eyebrow">BUILT FOR TRUST</span><h2>Proof, not just<br/>progress bars.</h2><p className="cd-section-lead">Your backend already separates browser actions from verified results. This dashboard connects to actual FlowFix API endpoints instead of replaying static test data.</p><div className="cd-arch-list"><div><ShieldCheck size={19}/><span><b>Three-state verification</b><small>Explicit PASS, FAIL, or INCONCLUSIVE outcomes.</small></span></div><div><Database size={19}/><span><b>Persistent records</b><small>Versioned contracts, SQLite-backed history and audit log.</small></span></div><div><CircleHelp size={19}/><span><b>Honest diagnostics</b><small>Clear evidence gaps and recommended next actions.</small></span></div></div></div>
      <div className="cd-arch-card"><div className="cd-arch-head"><span><Activity size={17}/> Verification pipeline</span><span className="cd-arch-pill">ACTIVE MODULES</span></div><div className="cd-arch-flow">{[{icon:FileCheck2,t:'Business requirement',s:'Contract checks'},{icon:Bot,t:'Browser execution',s:'TinyFish agent'},{icon:Layers,t:'Independent evidence',s:'Page / REST / SQLite'},{icon:ShieldCheck,t:'Verdict & diagnosis',s:'Auditable report'}].map((x,i)=><div className="cd-flow-item" key={x.t}><span className="cd-flow-icon"><x.icon size={19}/></span><div><b>{x.t}</b><small>{x.s}</small></div><span className="cd-flow-index">{i+1}</span></div>)}</div><Link href="/integrations">Explore supported integrations <ArrowRight size={15}/></Link></div></section>

      <section id="faq" className="cd-section cd-alt"><div className="cd-container cd-faq-grid"><div><span className="cd-eyebrow">FAQ</span><h2>Questions?<br/>We&apos;ve got answers.</h2><p className="cd-section-lead">Understand what the current product does, what it proves, and where integrations are still in development.</p><Link className="cd-btn cd-btn-outline" href="/settings">View platform readiness <ArrowUpRight size={15}/></Link></div><div className="cd-faq-list">{faq.map(f=><details key={f.q}><summary>{f.q}<ChevronDown size={18}/></summary><p>{f.a}</p></details>)}</div></div></section>

      <section className="cd-final-cta cd-container"><div><span className="cd-eyebrow">START WITH A REAL TEST</span><h2>Make every outcome<br/>accountable.</h2><p>Go from an assertion to independent evidence in one workspace.</p><Link className="cd-btn cd-btn-light cd-btn-large" href="/tests/new">Open test builder <ArrowRight size={17}/></Link></div><div className="cd-final-orb"><ShieldCheck size={82} strokeWidth={1.1}/></div></section>
    </main>
    <footer className="cd-footer"><div className="cd-container cd-footer-content"><div><Link href="/" className="cd-logo"><span><Zap size={17} fill="currentColor"/></span>FlowFix<span className="cd-logo-accent">AI</span></Link><p>From requirements to real business outcomes.</p></div><nav><Link href="/workspace">Dashboard</Link><Link href="/tests/new">Tests</Link><Link href="/history">History</Link><Link href="/audit">Audit</Link><a href="https://github.com/Aayushii-code/FlowFix-AI" target="_blank" rel="noreferrer" aria-label="GitHub source"><Github size={18}/></a></nav><div className="cd-copy">Â© {new Date().getFullYear()} FlowFix AI Â· Independent verification is not inferred from agent completion.</div></div></footer>
  </div>;
}
