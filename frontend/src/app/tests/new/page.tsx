"use client";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowLeft, ArrowRight, Braces, Check, ChevronDown, Globe2, Plus, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
import Link from "next/link";
import { createRun } from "@/lib/api";
import type { ComparisonOperator, VerificationCheck } from "@/lib/contracts";

const blankCheck = (): VerificationCheck => ({key:"", operator:"equals", expected:""});
export default function NewTestPage() {
  const router = useRouter();
  const [url,setUrl]=useState("");
  const [requirement,setRequirement]=useState("");
  const [checks,setChecks]=useState<VerificationCheck[]>([blankCheck()]);
  const [submitting,setSubmitting]=useState(false);
  const [problem,setProblem]=useState<string|null>(null);
  const [touched,setTouched]=useState(false);
  const urlValid=(()=>{try {const parsed = new URL(url); return parsed.protocol==="https:" && !!parsed.hostname && !parsed.username && !parsed.password;} catch {return false;}})();
  const checksValid=checks.length>0 && checks.every(check=>check.key.trim()&&check.expected.trim());
  const canSubmit=urlValid && requirement.trim().length>=12 && checksValid && !submitting;
  function editCheck(i:number,key:keyof VerificationCheck,val:string){setChecks(old=>old.map((c,j)=>i===j?{...c,[key]:val}:c));}
  async function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();setTouched(true);setProblem(null);if(!canSubmit)return;setSubmitting(true);try {const run=await createRun({url:url.trim(),requirement:requirement.trim(),checks:checks.map(c=>({...c,key:c.key.trim(),expected:c.expected.trim()}))});router.push(`/runs/${encodeURIComponent(run.id)}`);}catch(err){setProblem(err instanceof Error?err.message:"Unable to start test.");}finally{setSubmitting(false);}}
  return <div className="page-stack">
    <div className="page-intro"><div><div className="eyebrow eyebrow-with-dot"><span/> TEST BUILDER</div><h1>Create a test<span className="headline-dot">.</span></h1><p>Define a real website journey and the exact outcome you expect to verify.</p></div><Link href="/" className="button button-outline"><ArrowLeft size={16}/> Back to overview</Link></div>
    <div className="builder-grid"><form className="form-panel" onSubmit={submit} noValidate>
      <div className="form-heading"><div className="heading-icon"><Globe2 size={20}/></div><div><h2>Configure your test</h2><p>Everything below will be used in an actual API request.</p></div></div>
      <div className="form-body">
      <div className="form-group"><label htmlFor="website-url">Website URL <span>*</span></label><div className="input-with-icon"><Globe2 size={19}/><input id="website-url" type="url" value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://your-authorized-website.com" autoComplete="url" required aria-invalid={touched&&!urlValid}/></div><p className="field-helper">Use an HTTPS website that you own or are authorized to test.</p>{touched&&!urlValid&&<p className="field-error">Enter a valid HTTPS URL without credentials.</p>}</div>
      <div className="form-divider"/>
      <div className="form-group"><label htmlFor="requirement">Test instruction <span>*</span></label><textarea id="requirement" rows={5} value={requirement} onChange={e=>setRequirement(e.target.value)} placeholder="Describe the exact actions the agent should perform and what it should observe…" required aria-invalid={touched&&requirement.trim().length<12}/><div className="field-helper-row"><span>Describe one clear, testable journey.</span><span>{requirement.length} characters</span></div>{touched&&requirement.trim().length<12&&<p className="field-error">Please enter at least 12 characters.</p>}</div>
      <div className="form-divider"/>
      <div className="form-group"><div className="form-group-heading"><div><label>Verification checks <span>*</span></label><p className="field-helper">These define correct behavior. The backend must extract observations under these exact keys.</p></div><div className="tiny-tag"><Braces size={14}/> Exact checks</div></div>
        <div className="check-list">{checks.map((check,index)=><div className="check-card" key={index}><div className="check-card-top"><span>CHECK {String(index+1).padStart(2,"0")}</span><button type="button" disabled={checks.length===1} onClick={()=>setChecks(old=>old.filter((_,i)=>i!==index))} aria-label={`Remove check ${index+1}`} className="icon-button remove-check"><Trash2 size={17}/></button></div><div className="check-grid"><div className="form-group compact"><label htmlFor={`check-key-${index}`}>Observation key</label><input id={`check-key-${index}`} value={check.key} onChange={e=>editCheck(index,"key",e.target.value)} placeholder="Result field name" required/></div><div className="form-group compact"><label htmlFor={`check-operator-${index}`}>Comparison</label><div className="select-wrap"><select id={`check-operator-${index}`} value={check.operator} onChange={e=>editCheck(index,"operator",e.target.value as ComparisonOperator)}><option value="equals">Equals</option><option value="contains">Contains</option><option value="not_equals">Not equals</option></select><ChevronDown size={15}/></div></div><div className="form-group compact check-value"><label htmlFor={`check-value-${index}`}>Expected value</label><input id={`check-value-${index}`} value={check.expected} onChange={e=>editCheck(index,"expected",e.target.value)} placeholder="What should be observed?" required/></div></div></div>)}</div>
        <button type="button" className="add-check" onClick={()=>setChecks(old=>[...old,blankCheck()])}><Plus size={16}/> Add another check</button>{touched&&!checksValid&&<p className="field-error">Complete every observation key and expected value.</p>}
      </div>
      {problem&&<div className="alert-error" role="alert"><AlertCircle size={19}/><div><strong>Test was not started</strong><p>{problem}</p></div></div>}
      <div className="form-submit-row"><div><ShieldCheck size={17}/><span>No simulated results. All runs must come from the backend.</span></div><button className="button button-primary submit-button" type="submit" disabled={submitting}>{submitting?"Starting real run…":"Run test"}<ArrowRight size={17}/></button></div>
      </div>
    </form>
    <aside className="builder-aside"><div className="aside-card purple-note"><div className="aside-icon"><Sparkles size={22}/></div><h3>Test real behavior.</h3><p>FlowFix asks TinyFish to perform website actions, then compares returned observations with your configured expectations.</p><div className="aside-points"><span><Check size={15}/> Actual browser execution</span><span><Check size={15}/> Explicit comparisons</span><span><Check size={15}/> No invented verdicts</span></div></div><div className="aside-card"><div className="aside-heading"><CircleHelp size={18}/><h3>Before you begin</h3></div><div className="aside-list"><div><span>01</span><p>Use an authorized, publicly accessible site. Localhost won't be reachable by a cloud agent.</p></div><div><span>02</span><p>Make your instruction specific. Include the actions and which values to observe.</p></div><div><span>03</span><p>Observation keys are matched to real returned fields—not hardcoded sample data.</p></div><div><span>04</span><p>Testing backend must be connected before a real test can start.</p></div></div></div></aside></div>
  </div>;
}
