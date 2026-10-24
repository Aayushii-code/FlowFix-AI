"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ChevronRight, History, Plus, RotateCw, Search } from "lucide-react";
import { listRuns } from "@/lib/api";
import type { TestRun } from "@/lib/contracts";
import { prettyDate, hostFromUrl } from "@/lib/format";
import { Badge, EmptyState, ErrorNotice, Loading, Panel } from "@/components/shared";

export default function HistoryPage(){
  const [runs,setRuns]=useState<TestRun[]|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState<string|null>(null);
  const [query,setQuery]=useState("");
  const load=useCallback(async()=>{setLoading(true);setError(null);try{setRuns(await listRuns());}catch(e){setError(e instanceof Error?e.message:"Couldn't retrieve run history.");setRuns(null);}finally{setLoading(false);}},[]);
  useEffect(()=>{void load();},[load]);
  const filtered=(runs||[]).filter(run=>`${run.url} ${run.requirement} ${run.id}`.toLowerCase().includes(query.toLowerCase())).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
  return <div className="page-stack"><div className="page-intro"><div><div className="eyebrow eyebrow-with-dot"><span/> EXECUTION LIBRARY</div><h1>Run history<span className="headline-dot">.</span></h1><p>Every item here comes from a real recorded execution. No sample runs.</p></div><Link href="/tests/new" className="button button-primary"><Plus size={17}/> New test</Link></div>
    <Panel><div className="history-toolbar"><div className="history-heading"><div className="heading-icon"><History size={19}/></div><div><h2>All executions</h2><p>{runs?`${runs.length} recorded runs`:"Connect backend to load runs"}</p></div></div><div className="toolbar-actions"><div className="search-box"><Search size={17}/><input aria-label="Search actual runs" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search real runs…"/></div><button onClick={()=>void load()} className="icon-button refresh-button" aria-label="Refresh run history" title="Refresh actual data"><RotateCw size={18}/></button></div></div>
      {loading?<Loading/>:error?<div className="panel-inset"><ErrorNotice message={error} retry={()=>void load()}/></div>:runs&&runs.length===0?<EmptyState title="Your history starts here" message="Once your first real browser run finishes, its record will appear here."/>:filtered.length===0?<div className="filtered-empty">No actual runs match your search.</div>:<div className="history-table"><div className="table-head"><span>WEBSITE & REQUIREMENT</span><span>STARTED</span><span>STATUS</span><span>VERDICT</span><span/></div>{filtered.map(run=><Link href={`/runs/${encodeURIComponent(run.id)}`} key={run.id} className="table-row"><div className="table-primary"><strong>{hostFromUrl(run.url)}</strong><span>{run.requirement}</span></div><span className="table-date">{prettyDate(run.createdAt)}</span><Badge status={run.status}/><span>{run.verdict?<Badge verdict={run.verdict}/>:<span className="table-dash">—</span>}</span><ChevronRight size={17} className="table-arrow"/></Link>)}</div>}
    </Panel></div>;
}
