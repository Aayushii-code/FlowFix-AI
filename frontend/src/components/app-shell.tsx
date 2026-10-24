"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Activity, ArrowUpRight, BookOpenText, ChevronRight, CircleHelp, Github, History, LayoutGrid, Menu, Plus, Settings2, ShieldCheck, X } from "lucide-react";

const nav = [
  { href: "/", label: "Overview", icon: LayoutGrid },
  { href: "/tests/new", label: "New test", icon: Plus },
  { href: "/history", label: "Run history", icon: History },
  { href: "/settings", label: "About & setup", icon: Settings2 },
];
const pageTitle = (pathname: string) => {
  if (pathname === "/") return "Overview";
  if (pathname === "/tests/new") return "Create a test";
  if (pathname === "/history") return "Run history";
  if (pathname.startsWith("/runs/")) return "Execution details";
  return "About & setup";
};
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  return (
    <div className="app-frame">
      {open && <button className="mobile-scrim" aria-label="Close navigation" onClick={() => setOpen(false)} />}
      <aside className={`sidebar ${open ? "sidebar-open" : ""}`}>
        <div className="sidebar-brand"><div className="brand-mark"><span/><span/><span/><span/></div><div><div className="brand-name">flowfix<span>.ai</span></div><div className="brand-subtitle">VERIFY WITH CONFIDENCE</div></div><button className="icon-button sidebar-close" onClick={() => setOpen(false)} aria-label="Close navigation"><X size={18}/></button></div>
        <div className="workspace-pill"><span className="workspace-symbol">I</span><div><strong>Innovatrix</strong><small>Project workspace</small></div><ChevronRight size={16}/></div>
        <p className="nav-heading">WORKSPACE</p>
        <nav className="nav-list" aria-label="Main navigation">{nav.map(item => {const active = pathname === item.href; const Icon = item.icon; return <Link href={item.href} key={item.href} className={`nav-link ${active ? "nav-active" : ""}`} onClick={() => setOpen(false)}><Icon size={18} strokeWidth={1.9}/><span>{item.label}</span>{active && <span className="active-dot"/>}</Link>;})}</nav>
        <p className="nav-heading nav-heading-secondary">RESOURCES</p>
        <a className="nav-link nav-secondary" href="https://docs.tinyfish.ai/" target="_blank" rel="noopener noreferrer"><BookOpenText size={18}/>TinyFish docs<ArrowUpRight size={15} className="nav-end"/></a>
        <a className="nav-link nav-secondary" href="https://github.com/Aayushii-code/FlowFix-AI" target="_blank" rel="noopener noreferrer"><Github size={18}/>Source repository<ArrowUpRight size={15} className="nav-end"/></a>
        <div className="sidebar-spacer" />
        <div className="sidebar-help"><div className="help-icon"><ShieldCheck size={19}/></div><strong>Results you can trace.</strong><p>Every verdict should be grounded in a real browser run and explicit checks.</p><Link href="/settings">Our approach <ArrowUpRight size={14}/></Link></div>
        <div className="sidebar-footer"><div className="avatar-mark">IN</div><div><strong>Team Innovatrix</strong><small>FlowFix AI</small></div><CircleHelp size={16}/></div>
      </aside>
      <div className="main-shell">
        <header className="topbar"><div className="topbar-left"><button className="mobile-toggle icon-button" aria-label="Open navigation" onClick={() => setOpen(true)}><Menu size={21}/></button><span className="breadcrumb-root">Workspace</span><ChevronRight size={15} className="breadcrumb-sep"/><span className="breadcrumb-current">{pageTitle(pathname)}</span></div><div className="topbar-right"><span className="real-data-indicator"><span/> LIVE DATA ONLY</span><div className="topbar-avatar">IN</div></div></header>
        <main className="main-content">{children}</main>
        <footer className="app-footer"><span>© {new Date().getFullYear()} FlowFix AI · Built by Innovatrix</span><span><Activity size={14}/> No simulated executions</span></footer>
      </div>
    </div>
  );
}
