'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LayoutDashboard, FlaskConical, ScrollText, History, ShoppingBag, Network, Activity, Plug, Settings2, ArrowUpRight, CircleDot, ShieldCheck, PanelLeftClose, PanelLeftOpen, Plus, ChevronRight } from 'lucide-react';
import { api, Capabilities } from '@/lib/platform';
const nav = [
  { group: 'WORKSPACE', items: [
    { label: 'Overview', href: '/', icon: LayoutDashboard },
    { label: 'New verification', href: '/tests/new', icon: FlaskConical },
    { label: 'Contract library', href: '/contracts', icon: ScrollText },
    { label: 'Execution history', href: '/history', icon: History },
  ]},
  { group: 'ASSURANCE', items: [
    { label: 'E-commerce sandbox', href: '/commerce', icon: ShoppingBag },
    { label: 'Cross-system checks', href: '/cross-system', icon: Network },
    { label: 'Audit activity', href: '/audit', icon: Activity },
  ]},
  { group: 'PLATFORM', items: [
    { label: 'Integrations', href: '/integrations', icon: Plug },
    { label: 'System status', href: '/settings', icon: Settings2 },
  ]}
];
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [compact, setCompact] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [health, setHealth] = useState<Capabilities | null>(null);
  useEffect(() => { let mounted = true; api<Capabilities>('capabilities').then(x => { if (mounted) setHealth(x); }).catch(() => {}); return () => {mounted = false;}; }, []);
  return <div className={`shell ${compact ? 'shell-compact' : ''}`}>
    <aside className={`sidebar ${mobileMenu ? 'sidebar-mobile-open' : ''}`}>
      <div className="brand-row"><Link href="/" className="brand" onClick={() => setMobileMenu(false)}><span className="brand-mark"><i/><i/><i/><i/></span><span className="brand-text"><strong>flowfix<span>.ai</span></strong><small>ASSURANCE OS</small></span></Link><button className="icon-btn sidebar-toggle" aria-label="Toggle sidebar" onClick={() => setCompact(!compact)}>{compact ? <PanelLeftOpen size={17}/> : <PanelLeftClose size={17}/>}</button></div>
      <div className="workspace-card"><div className="workspace-avatar">IN</div><div className="workspace-meta"><strong>Innovatrix</strong><span>Engineering workspace</span></div><ChevronRight size={15}/></div>
      <nav className="nav-menu">{nav.map(section => <div className="nav-section" key={section.group}><div className="nav-heading">{section.group}</div>{section.items.map(item => { const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);const Icon = item.icon;return <Link key={item.href} href={item.href} onClick={() => setMobileMenu(false)} className={`nav-item ${active ? 'is-active' : ''}`} title={item.label}><Icon size={17}/><span>{item.label}</span>{active && <span className="nav-active-indicator"/>}</Link>;})}</div>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-status"><span className={`pulse-dot ${health?.tinyfish?.configured ? '' : 'pulse-muted'}`}/><div><strong>{health ? (health.tinyfish?.configured ? 'TinyFish connected' : 'TinyFish unconfigured') : 'Platform status'}</strong><small>{health?.verification?.engine ? `Verifier: ${health.verification.engine}` : 'Live API configuration'}</small></div></div><p>Verifiable outcomes.<br/>Zero invented evidence.</p></div>
    </aside>
    {mobileMenu && <button className="mobile-overlay" aria-label="Close menu" onClick={() => setMobileMenu(false)}/>}
    <div className="app-main"><header className="topbar"><div className="topbar-left"><button className="icon-btn mobile-toggle" aria-label="Menu" onClick={() => setMobileMenu(!mobileMenu)}><PanelLeftOpen size={20}/></button><span className="breadcrumb-root">INNOVATRIX</span><ChevronRight size={14}/><span className="breadcrumb-current">{[...nav.flatMap(n=>n.items)].find(x=>x.href!=='/' && pathname.startsWith(x.href))?.label ?? (pathname.startsWith('/runs/') ? 'Execution details' : 'Overview')}</span></div><div className="topbar-right"><span className="live-label"><CircleDot size={13}/> LIVE SYSTEM DATA</span><Link href="/tests/new" className="topbar-create"><Plus size={16}/> New test</Link><span className="user-avatar">IN</span></div></header><main className="page-container">{children}</main><footer className="app-footer"><span><ShieldCheck size={14}/> FlowFix Assurance OS</span><span>Browser execution ≠ verified outcome</span><a target="_blank" rel="noreferrer" href="https://github.com/Aayushii-code/FlowFix-AI">Source <ArrowUpRight size={13}/></a></footer></div>
  </div>;
}
