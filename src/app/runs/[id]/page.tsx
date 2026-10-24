"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Bot, CalendarDays, Clock3, ExternalLink, Globe2, Hash, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { getRun } from "@/lib/api";
import type { TestRun } from "@/lib/contracts";
import { hostFromUrl, prettyDate } from "@/lib/format";
import { Badge, ErrorNotice, Loading, Panel } from "@/components/shared";

export default function RunDetailsPage(){
  const params=useParams();
  const id=typeof params.id==="string"?params.id:"";
  const [run,setRun]=useState<TestRun|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [loading,setLoading]=useState(true);
  const load=useCallback(async()=>{if(!id)return;setError(null);try{setRun(await getRun(id));}catch(e){setError(e instanceof Error?e.message:"Unable to retrieve execution.");}finally{setLoading(false);}},[id]);
  useEffect(()=>{void load();},[load]);
  useEffect(()=>{if(!run||!(["queued","running"] as string[]).includes(run.status))return;const handle=window.setInterval(()=>{void load();},4500);return()=>window.clearInterval(handle);},[run,load]);
  return <div className="page-stack"><div className="page-intro"><div><div className="eyebrow eyebrow-with-dot"><span/> EXECUTION DETAILS</div><h1>Test report<span className="headline-dot">.</span></h1><p>Actual run state and independently verified observations.</p></div><div className="page-actions"><Link href="/history" className="button button-outline"><ArrowLeft size={16}/> Run history</Link><button className="button button-primary" onClick={()=>{setLoading(true);void load();}}><RefreshCw size={17}/> Refresh</button></div></div>
  {error&&<ErrorNotice message={error} retry={()=>{setLoading(true);void load();}}/>}
  {loading&&!run?<Panel><Loading/></Panel>:run?<>
    <div className="report-banner"><div><div className="eyebrow">EXECUTION RECORD</div><h2>{hostFromUrl(run.url)}</h2><p>{run.requirement}</p></div><div className="report-banner-status"><Badge status={run.status}/>{run.verdict&&<Badge verdict={run.verdict}/>}</div></div>
    {run.status==="running"||run.status==="queued"?<div className="progress-notice"><span className="progress-spinner"/><div><strong>{run.status==="queued"?"Run queued":"Browser agent is running"}</strong><p>Requesting actual provider status every few seconds. No artificial progress percentage is displayed.</p></div></div>:null}
    {run.error&&<ErrorNotice message={run.error}/>}
    <div className="report-meta-grid"><div className="meta-tile"><Globe2 size={18}/><span>Target website</span><a href={run.url} rel="noopener noreferrer" target="_blank">{hostFromUrl(run.url)} <ExternalLink size={13}/></a></div><div className="meta-tile"><Hash size={18}/><span>Run ID</span><strong className="break-all">{run.id}</strong></div><div className="meta-tile"><CalendarDays size={18}/><span>Started</span><strong>{prettyDate(run.createdAt)}</strong></div><div className="meta-tile"><Clock3 size={18}/><span>Completed</span><strong>{prettyDate(run.completedAt)}</strong></div></div>
    <div className="report-grid"><Panel className="report-panel"><div className="panel-title-row"><div className="heading-icon"><ShieldCheck size={20}/></div><div><h2>Verification checks</h2><p>Configured expectations and real returned fields</p></div></div><div className="verification-table"><div className="verify-table-head"><span>FIELD</span><span>EXPECTED</span><span>OBSERVED</span></div>{run.checks.map((check,i)=><div className="verify-row" key={`${check.key}-${i}`}><div><strong>{check.key}</strong><small>{check.operator.replaceAll("_"," ")}</small></div><div className="cell-text">{check.expected}</div><div className="cell-text">{run.observations&&Object.prototype.hasOwnProperty.call(run.observations,check.key)?run.observations[check.key]:<span className="muted">Not observed</span>}</div></div>)}</div><div className="verification-foot"><ShieldCheck size={17}/><span>Verdict is calculated by backend logic, not inferred from agent completion alone.</span></div></Panel>
    <Panel className="report-panel"><div className="panel-title-row"><div className="heading-icon"><Bot size={20}/></div><div><h2>Browser execution</h2><p>Real execution metadata</p></div></div><div className="report-info-list"><div><span>Provider run ID</span><strong className="break-all">{run.providerRunId||"Not available yet"}</strong></div><div><span>Execution status</span><Badge status={run.status}/></div><div><span>Verification verdict</span>{run.verdict?<Badge verdict={run.verdict}/>:<span className="muted">Awaiting result</span>}</div><div><span>Observation fields</span><strong>{run.observations?Object.keys(run.observations).length:"Not returned"}</strong></div></div><div className="report-note"><Sparkles size={17}/><p>We show only evidence actually returned by the provider. No simulated screenshots or steps are generated.</p></div></Panel></div>
  </>:null}</div>;
}
