'use client';
import React from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, XCircle, Clock3, CircleHelp, Loader2, ArrowUpRight, RefreshCw } from 'lucide-react';
import { friendlyError, verdictKind } from '@/lib/platform';

export function Eyebrow({ children }: {children: React.ReactNode}) { return <div className="eyebrow"><span className="eyebrow-dot"/>{children}</div> }
export function PageTitle({ eyebrow, title, description, action }: {eyebrow: string; title: string; description?: string; action?: React.ReactNode}) {return <div className="page-head"><div><Eyebrow>{eyebrow}</Eyebrow><h1>{title}</h1>{description && <p className="page-desc">{description}</p>}</div>{action && <div className="page-head-actions">{action}</div>}</div>}
export function Status({ value }: {value?: string | null}) {const v = (value || 'UNVERIFIED').toUpperCase();const kind=verdictKind(v);const display = v==='INCONCLUSIVE'?'Inconclusive':v.replaceAll('_',' ').toLowerCase().replace(/^./,c=>c.toUpperCase());const state=['QUEUED','RUNNING'].includes(v)?'progress': ['FAILED','TIMED_OUT'].includes(v)?'fail':v==='COMPLETED'?'success':kind;return <span className={`status-pill status-${state}`}><span className="status-dot"/>{display}</span>}
export function Verdict({ value }: {value?:string|null}) {return <Status value={value??'UNVERIFIED'}/>}
export function Panel({ children, className='', title, subtitle, action }: {children:React.ReactNode;className?:string; title?:string;subtitle?:string;action?:React.ReactNode}) {return <section className={`panel ${className}`}>{title && <div className="panel-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{action}</div>}{children}</section>}
export function Empty({ title, text, action }: {title:string;text:string;action?:React.ReactNode}) {return <div className="empty-state"><div className="empty-symbol"><CircleHelp size={23}/></div><h3>{title}</h3><p>{text}</p>{action}</div>}
export function ErrorBanner({ error }: {error:unknown}) {if(!error)return null;return <div className="error-banner"><AlertTriangle size={18}/><div><strong>Request could not be completed</strong><p>{friendlyError(error)}</p></div></div>}
export function Spinner({ text='Loading live data…' }: {text?:string}) {return <div className="loading"><Loader2 className="spin" size={19}/>{text}</div>}
export function Button({ children, onClick, disabled, variant='primary', type='button', className='' }: {children:React.ReactNode;onClick?:()=>void;disabled?:boolean;variant?:'primary'|'outline'|'ghost'|'danger';type?:'button'|'submit';className?:string}) {return <button type={type} onClick={onClick} disabled={disabled} className={`btn btn-${variant} ${className}`}>{children}</button>}
export function PrimaryLink({href,children}: {href:string;children:React.ReactNode}) {return <Link className="btn btn-primary" href={href}>{children}<ArrowUpRight size={15}/></Link>}
export function Refresh({onClick,loading}: {onClick:()=>void;loading?:boolean}) {return <Button variant="outline" onClick={onClick} disabled={loading}><RefreshCw size={15} className={loading?'spin':''}/>Refresh</Button>}
export function SectionLabel({children}: {children:React.ReactNode}) {return <div className="section-label">{children}</div>}
export function Metric({label,value,icon,sub}: {label:string;value:React.ReactNode;icon:React.ReactNode;sub?:string}) {return <div className="metric"><div className="metric-top"><span>{label}</span><span className="metric-icon">{icon}</span></div><strong>{value}</strong><p>{sub??'Live workspace data'}</p></div>}
export function RiskIcon({status}: {status:string}) {if(status==='PASS')return <CheckCircle2 size={19}/>;if(status==='FAIL')return <XCircle size={19}/>;if(status==='RUNNING')return <Clock3 size={19}/>;return <CircleHelp size={19}/>}
export function Input({label, ...props}: React.InputHTMLAttributes<HTMLInputElement> & {label:string}) {return <label className="field"><span>{label}</span><input {...props}/></label>}
export function Textarea({label, ...props}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & {label:string}) {return <label className="field"><span>{label}</span><textarea {...props}/></label>}
export function Select({label,children,...props}: React.SelectHTMLAttributes<HTMLSelectElement> & {label:string;children:React.ReactNode}) {return <label className="field"><span>{label}</span><select {...props}>{children}</select></label>}
