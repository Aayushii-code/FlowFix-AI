import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, AlertTriangle, CircleCheck, Clock3, DatabaseZap, FileSearch, LoaderCircle, Plus, ShieldCheck, WifiOff } from "lucide-react";
import type { RunStatus, Verdict } from "@/lib/contracts";

export function SectionHeading({ eyebrow, title, note, action }: { eyebrow?: string; title: string; note?: string; action?: ReactNode }) {
  return <div className="section-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h2>{title}</h2>{note && <p>{note}</p>}</div>{action}</div>;
}
export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {return <section className={`panel ${className}`}>{children}</section>;}
export function Badge({ status, verdict }: {status?:RunStatus; verdict?: Verdict | null}) {
  const value = verdict || status || "UNKNOWN";
  const variant = value === "PASS" ? "success" : value === "FAIL" || value === "error" ? "danger" : value === "INCONCLUSIVE" ? "warning" : value === "running" ? "info" : "neutral";
  return <span className={`status-badge badge-${variant}`}><span className="badge-dot"/>{value === "error" ? "Error" : value.charAt(0).toUpperCase()+value.slice(1).toLowerCase()}</span>;
}
export function Loading({ label = "Loading actual run data…" }: { label?: string }) { return <div className="loading-state"><LoaderCircle size={24} className="spin"/><span>{label}</span></div>; }
export function ErrorNotice({ message, retry }: { message: string; retry?: () => void }) {return <div className="alert-error" role="alert"><WifiOff size={19}/><div><strong>Unable to load live data</strong><p>{message}</p></div>{retry && <button type="button" className="button button-ghost button-sm" onClick={retry}>Retry</button>}</div>;}
export function EmptyState({ title, message, action = true }: {title: string; message: string; action?: boolean}) {
  return <div className="empty-state"><div className="empty-icon"><FileSearch size={28} strokeWidth={1.5}/></div><h3>{title}</h3><p>{message}</p>{action && <Link className="button button-primary" href="/tests/new"><Plus size={17}/> Create your first test</Link>}</div>;
}
export function MetricCard({ title, value, detail, icon }: {title: string; value: number | string; detail: string; icon: ReactNode}) {return <div className="metric-card"><div className="metric-top"><span>{title}</span><span className="metric-icon">{icon}</span></div><div className="metric-value">{value}</div><div className="metric-bottom">{detail}</div></div>;}
export { ArrowRight, AlertTriangle, CircleCheck, Clock3, DatabaseZap, ShieldCheck };
