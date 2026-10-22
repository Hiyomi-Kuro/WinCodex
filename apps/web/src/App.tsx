import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, AlertCircle, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, BookOpen, Check, CheckCircle2,
  ChevronDown, ChevronRight, CircleHelp, Clipboard, Clock3, Cloud, CloudCog, Code2, File, FileCode2,
  FileImage, FileSearch, FileText, Folder, FolderOpen, FolderPlus, HardDrive, Home, KeyRound, LoaderCircle,
  LockKeyhole, Menu, Moon, MoreHorizontal, Network, PanelLeftClose, Play, RefreshCw, Search, Settings2,
  ShieldCheck, SquareTerminal, Sun, Trash2, X, Zap,
} from 'lucide-react';

type Page = 'home' | 'roots' | 'files' | 'logs' | 'settings';
type Theme = 'system' | 'light' | 'dark';
type TunnelState = 'STOPPED' | 'STARTING' | 'CONNECTED' | 'DISCONNECTED' | 'AUTH_ERROR' | 'SERVICE_ERROR';
interface Settings {
  pluginName: string; tunnelId: string; networkTimeoutSeconds: number; autoReconnect: boolean;
  maxReadBytes: number; maxReadChars: number; maxOutputChars: number; debugLogging: boolean; theme: Theme;
}
interface Root { id: string; name: string; path: string; enabled: boolean; accessible: boolean; issue?: string; lastCheckAt?: string }
interface LogEntry { id: string; time: string; kind: string; message: string; durationMs?: number; bytes?: number; error?: boolean }
interface Entry { name: string; path: string; type: 'file'|'directory'|'blocked_reparse'; size_bytes: number; modified_iso: string|null; extension: string; image_metadata_only: boolean }
interface Snapshot {
  settings: Settings; credentials: { hasRuntimeApiKey: boolean; hasMcpBearer: boolean };
  roots: Root[]; tunnel: { serviceActive: boolean; tunnelState: TunnelState; tunnelId: string; lastError?: string; connectedAt?: string; lastToolCall?: string };
  stats: { filesRead: number; toolCalls: number; lastToolCall: string|null };
  recentLogs: LogEntry[]; system: { platform: string; version: string; architecture: string; node: string };
}

const nav: Array<{ id: Page; label: string; icon: typeof Home; hint: string }> = [
  { id:'home', label:'首页', icon:Home, hint:'运行总览' },
  { id:'roots', label:'目录授权', icon:HardDrive, hint:'只读根目录' },
  { id:'files', label:'文件管理', icon:FolderOpen, hint:'浏览与预览' },
  { id:'logs', label:'运行日志', icon:Activity, hint:'事件与请求' },
  { id:'settings', label:'设置', icon:Settings2, hint:'Tunnel 与偏好' },
];

export function App() {
  const [page, setPage] = useState<Page>('home');
  const [snapshot, setSnapshot] = useState<Snapshot|null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [toast, setToast] = useState<{ text: string; error?: boolean }|null>(null);
  const [busy, setBusy] = useState<string|null>(null);
  const [error, setError] = useState('');
  const [compact, setCompact] = useState(false);
  const csrf = useRef('');

  const notify = useCallback((text: string, isError = false) => {
    setToast({ text, error:isError });
    window.setTimeout(() => setToast(null), 3400);
  }, []);

  const call = useCallback(async <T,>(url: string, init: RequestInit = {}): Promise<T> => {
    const headers = new Headers(init.headers);
    if (init.body) headers.set('Content-Type', 'application/json');
    if (!['GET','HEAD'].includes((init.method ?? 'GET').toUpperCase())) headers.set('X-WinCodex-CSRF', csrf.current);
    const response = await fetch(url, { ...init, headers, cache:'no-store' });
    if (response.status === 204) return undefined as T;
    const data = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
    return data as T;
  }, []);

  const refresh = useCallback(async (initial = false) => {
    try {
      if (initial || !csrf.current) {
        const session = await fetch('/api/session', { cache:'no-store' }).then(r => r.json()) as { csrfToken:string };
        csrf.current = session.csrfToken;
      }
      const data = await call<Snapshot>('/api/state');
      setSnapshot(data); setError('');
      if (page === 'logs') { const response = await call<{logs:LogEntry[]}>('/api/logs'); setLogs(response.logs); }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '本地服务暂不可用';
      setError(message);
    }
  }, [call, page]);

  useEffect(() => { void refresh(true); }, []);
  useEffect(() => {
    const timer = window.setInterval(() => { void refresh(); }, 3500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const mutate = useCallback(async (name: string, action: () => Promise<unknown>, success: string) => {
    setBusy(name);
    try { await action(); await refresh(); notify(success); }
    catch (cause) { notify(cause instanceof Error ? cause.message : '操作失败', true); }
    finally { setBusy(null); }
  }, [notify, refresh]);

  const tunnelAction = useCallback((action: 'start'|'stop'|'reconnect'|'test') => mutate(`tunnel-${action}`, async () => {
    if (action === 'test') {
      const result = await call<{ tunnel:string; mcp:string; chatgpt:string }>('/api/tunnel/test', { method:'POST' });
      notify(`${result.tunnel}；${result.mcp}。${result.chatgpt}`);
    } else await call(`/api/tunnel/${action}`, { method:'POST' });
  }, action === 'test' ? '本机连接诊断完成' : action === 'start' ? 'Tunnel 服务正在启动' : action === 'stop' ? 'Tunnel 服务已停止' : '已发起重新连接'), [call, mutate, notify]);

  const rootAction = useCallback(async (id: string, action: 'toggle'|'test'|'delete', enabled?: boolean) => {
    const title = action === 'toggle' ? (enabled ? '已启用目录' : '已暂停目录') : action === 'test' ? '目录测试通过' : '已移除目录授权';
    await mutate(`root-${id}`, async () => {
      if (action === 'toggle') await call(`/api/roots/${encodeURIComponent(id)}`, { method:'PATCH', body:JSON.stringify({enabled}) });
      if (action === 'test') await call(`/api/roots/${encodeURIComponent(id)}/test`, { method:'POST', body:JSON.stringify({}) });
      if (action === 'delete') await call(`/api/roots/${encodeURIComponent(id)}`, { method:'DELETE' });
    }, title);
  }, [call, mutate]);

  const content = useMemo(() => {
    if (!snapshot) return <LoadingPanel error={error} onRetry={() => void refresh(true)} />;
    if (page === 'home') return <HomePage snapshot={snapshot} busy={busy} onAction={tunnelAction} onNavigate={setPage} />;
    if (page === 'roots') return <RootsPage roots={snapshot.roots} busy={busy} onAction={rootAction} call={call} notify={notify} refresh={() => void refresh()} />;
    if (page === 'files') return <FilesPage roots={snapshot.roots} call={call} notify={notify} />;
    if (page === 'logs') return <LogsPage logs={logs.length ? logs : snapshot.recentLogs} call={call} notify={notify} refresh={() => void refresh()} />;
    return <SettingsPage snapshot={snapshot} busy={busy} call={call} notify={notify} mutate={mutate} refresh={() => void refresh()} />;
  }, [snapshot, page, error, refresh, busy, tunnelAction, rootAction, call, notify, logs, mutate]);

  const pageMeta = nav.find(item => item.id === page)!;
  const state = snapshot?.tunnel.tunnelState ?? 'STOPPED';
  const theme = snapshot?.settings.theme ?? 'system';

  return <div className={`app-shell ${themeClass(theme)} ${compact?'compact':''}`}>
    <aside className="sidebar">
      <div className="brand-row">
        <div className="brand-mark"><Code2 size={21}/></div>
        {!compact && <div className="brand-copy"><strong>WinCodex</strong><span>LOCAL MCP BRIDGE</span></div>}
      </div>
      <div className="nav-label">工作台</div>
      <nav className="nav-list">
        {nav.map(({id,label,icon:Icon,hint}) => <button key={id} className={`nav-item ${page===id?'active':''}`} onClick={() => setPage(id)} title={compact?label:undefined}>
          <Icon size={18}/>{!compact && <><span>{label}</span>{id==='roots'&&snapshot?.roots.length ? <i className="nav-count">{snapshot.roots.length}</i> : <small>{hint}</small>}</>}
        </button>)}
      </nav>
      <div className="sidebar-spacer"/>
      <div className="sidebar-health">
        <span className={`health-orb ${state.toLowerCase()}`}/>
        {!compact && <div><strong>{stateLabel(state)}</strong><span>{snapshot?.tunnel.serviceActive?'后台服务运行中':'本地页面可用'}</span></div>}
        {!compact && <button className="icon-btn slim" onClick={()=>setPage('settings')} aria-label="打开设置"><ChevronRight size={15}/></button>}
      </div>
      <button className="collapse-btn" onClick={()=>setCompact(value=>!value)}><PanelLeftClose size={17}/>{!compact&&<span>收起侧栏</span>}</button>
    </aside>

    <main className="main-shell">
      <header className="topbar">
        <div className="topbar-title"><span>WinCodex</span><ChevronRight size={14}/><strong>{pageMeta.label}</strong></div>
        <div className="topbar-actions">
          <div className={`top-status ${state.toLowerCase()}`}><span className="health-orb"/><span>{stateLabel(state)}</span></div>
          <div className="top-divider"/>
          <button className="profile-chip" onClick={()=>setPage('settings')}><span className="profile-avatar">W</span><span>本机服务</span><ChevronDown size={14}/></button>
        </div>
      </header>
      <section className="page-wrap">
        {snapshot && <div className="page-heading"><div><div className="eyebrow">WINCODEX · WINDOWS MCP</div><h1>{pageMeta.label}</h1><p>{pageDescription(page)}</p></div>{page==='home'&&<div className="heading-date"><span>本机运行环境</span><strong>{new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium'}).format(new Date())}</strong></div>}</div>}
        {content}
      </section>
    </main>
    {toast&&<div className={`toast ${toast.error?'error':''}`}><span>{toast.error?<AlertCircle size={17}/>:<CheckCircle2 size={17}/>}</span>{toast.text}</div>}
  </div>;
}

function HomePage({ snapshot, busy, onAction, onNavigate }:{snapshot:Snapshot;busy:string|null;onAction:(action:'start'|'stop'|'reconnect'|'test')=>void;onNavigate:(page:Page)=>void}) {
  const { tunnel, roots, stats, settings, credentials, system, recentLogs }=snapshot;
  const activeRoots=roots.filter(root=>root.enabled&&root.accessible).length;
  const recentCall=recentLogs.find(item=>item.kind==='MCP 请求'||item.kind==='读取成功'||item.kind==='文件访问');
  return <div className="home-grid">
    <div className="home-main">
      <div className="hero-card">
        <div className="hero-glow"/><div className="hero-content"><div className="hero-kicker"><span className="hero-kicker-dot"/>本机文件服务 <span className="hero-kicker-divider"/>只读连接</div>
          <h2>让你的文件保持<br/><em>在自己的电脑上。</em></h2><p>WinCodex 只通过你授权的 Windows 目录响应 MCP 请求。Tunnel 状态会与 ChatGPT 连接器注册状态分别显示。</p>
          <div className="hero-actions"><button className="btn btn-primary" onClick={()=>onAction(tunnel.serviceActive?'stop':'start')} disabled={busy!==null}>{busy===`tunnel-${tunnel.serviceActive?'stop':'start'}`?<LoaderCircle className="spin" size={16}/>:tunnel.serviceActive?<SquareTerminal size={16}/>:<Play size={16}/>} {tunnel.serviceActive?'停止 Tunnel':'启动服务'}</button><button className="btn btn-ghost" onClick={()=>onAction('test')} disabled={busy!==null}><Activity size={16}/>测试连接</button></div>
          <div className="hero-meta"><span><ShieldCheck size={14}/>默认仅本机访问</span><span><LockKeyhole size={14}/>MCP 只读工具</span><span><Cloud size={14}/>出站 TLS Tunnel</span></div>
        </div><div className="hero-side"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="orbit orbit-three"/><div className="core-node"><Code2 size={30}/></div><div className="orbit-node node-files"><Folder size={16}/></div><div className="orbit-node node-cloud"><Cloud size={16}/></div><div className="orbit-node node-lock"><LockKeyhole size={15}/></div><div className="connection-line line-left"/><div className="connection-line line-right"/><span className="orbit-label label-files">本地文件</span><span className="orbit-label label-tunnel">Secure Tunnel</span><span className="orbit-caption">你选择的目录 ↔ MCP</span></div>
      </div>
      <div className="stat-grid">
        <StatCard icon={FolderOpen} label="已授权目录" value={`${activeRoots}`} detail={`共 ${roots.length} 个记录`} tone="blue" action={()=>onNavigate('roots')}/>
        <StatCard icon={FileText} label="已读取文件" value={formatNumber(stats.filesRead)} detail="成功读取计数" tone="teal" action={()=>onNavigate('logs')}/>
        <StatCard icon={Zap} label="MCP 工具" value="10" detail={`${formatNumber(stats.toolCalls)} 次调用`} tone="violet" action={()=>onNavigate('settings')}/>
      </div>
      <div className="section-title-row"><div><h3>最近活动</h3><p>服务与文件请求的最新本地记录</p></div><button className="text-button" onClick={()=>onNavigate('logs')}>查看全部 <ArrowRight size={15}/></button></div>
      <div className="activity-card">{recentLogs.length?recentLogs.slice(0,5).map(log=><ActivityRow key={log.id} log={log}/>):<EmptyState icon={Activity} title="暂无运行记录" description="启动 Tunnel 或浏览授权目录后，活动会显示在这里。"/>}</div>
    </div>
    <div className="home-side">
      <div className="panel connection-panel"><div className="panel-top"><div><span className="panel-icon violet"><Network size={17}/></span><div><h3>Tunnel 连接</h3><p>本地服务与 OpenAI 控制面</p></div></div><span className={`state-pill ${tunnel.tunnelState.toLowerCase()}`}><i/> {stateLabel(tunnel.tunnelState)}</span></div>
        <div className="tunnel-visual"><div className="tunnel-endpoint"><span className="endpoint-icon"><Code2 size={16}/></span><span><b>WinCodex</b><small>本机 MCP 服务</small></span></div><div className={`tunnel-track ${tunnel.tunnelState==='CONNECTED'?'connected':''}`}><i/><i/><i/><i/><i/></div><div className="tunnel-endpoint endpoint-openai"><span className="endpoint-icon"><CloudCog size={17}/></span><span><b>OpenAI Tunnel</b><small>{tunnel.tunnelState==='CONNECTED'?'长轮询已响应':'等待连接'}</small></span></div></div>
        <div className="info-pair"><span>Tunnel ID</span><strong className="mono truncate" title={settings.tunnelId}>{settings.tunnelId||'尚未配置'}</strong></div>
        <div className="info-pair"><span>Runtime API Key</span><strong className={credentials.hasRuntimeApiKey?'good-text':'muted-text'}>{credentials.hasRuntimeApiKey?'已保存到 Windows 凭据库':'未配置'}</strong></div>
        <div className="info-pair"><span>ChatGPT 连接器</span><strong className="muted-text">需在 ChatGPT 网页确认</strong></div>
        <div className="panel-actions"><button className="btn btn-soft" onClick={()=>onAction('reconnect')} disabled={busy!==null}><RefreshCw size={15}/>重新连接</button><button className="btn btn-outline" onClick={()=>onNavigate('settings')}>配置 <ArrowRight size={14}/></button></div>
        {tunnel.lastError&&<div className="inline-alert"><AlertCircle size={15}/><span>{tunnel.lastError}</span></div>}
      </div>
      <div className="panel scope-panel"><div className="panel-heading"><span className="panel-icon teal"><ShieldCheck size={17}/></span><div><h3>访问边界</h3><p>所有请求遵循本机授权状态</p></div></div>
        <div className="scope-list"><div><span className="scope-check"><Check size={12}/></span><span>只读取已启用目录</span></div><div><span className="scope-check"><Check size={12}/></span><span>拒绝符号链接与目录越界</span></div><div><span className="scope-check"><Check size={12}/></span><span>不返回图片或二进制正文</span></div><div><span className="scope-check"><Check size={12}/></span><span>密钥不写入普通设置文件</span></div></div>
        <button className="panel-link" onClick={()=>onNavigate('roots')}>管理目录授权 <ArrowRight size={14}/></button>
      </div>
      <div className="mini-system"><span className="windows-logo">⊞</span><div><strong>{system.platform} · {system.architecture}</strong><span>{system.version} · Node {system.node}</span></div><button className="icon-btn" onClick={()=>onNavigate('settings')}><MoreHorizontal size={18}/></button></div>
      <div className="connector-note"><CircleHelp size={15}/><span>Tunnel 运行正常并不代表 ChatGPT 已注册此连接器。</span></div>
    </div>
  </div>;
}

function RootsPage({roots,busy,onAction,call,notify,refresh}:{roots:Root[];busy:string|null;onAction:(id:string,action:'toggle'|'test'|'delete',enabled?:boolean)=>void;call:<T,>(url:string,init?:RequestInit)=>Promise<T>;notify:(message:string,error?:boolean)=>void;refresh:()=>void}) {
  const [path,setPath]=useState(''); const [adding,setAdding]=useState(false);
  const add=async()=>{ if(!path.trim())return; setAdding(true); try{await call('/api/roots',{method:'POST',body:JSON.stringify({path:path.trim()})});setPath('');refresh();notify('目录已添加并完成 Windows 路径检查');}catch(e){notify(e instanceof Error?e.message:'目录添加失败',true);}finally{setAdding(false);} };
  const choose=async()=>{setAdding(true);try{const result=await call<{root?:Root}|undefined>('/api/roots/choose',{method:'POST'});if(result?.root){refresh();notify('所选目录已添加');}else notify('已取消选择目录。');}catch(e){notify(e instanceof Error?e.message:'选择目录失败',true);}finally{setAdding(false);} };
  return <div className="roots-layout">
    <div className="roots-main"><div className="toolbar-card roots-toolbar"><div className="toolbar-intro"><div className="large-icon pale-blue"><FolderPlus size={22}/></div><div><h3>添加只读目录</h3><p>仅授权你选择的目录，WinCodex 不会自动开放整个磁盘。</p></div></div><div className="add-actions"><button className="btn btn-primary" onClick={()=>void choose()} disabled={adding}><FolderOpen size={16}/>系统文件夹选择器</button><button className="btn btn-outline" onClick={()=>document.getElementById('manual-root')?.focus()}><HardDrive size={16}/>手动输入路径</button></div><div className="manual-row"><label htmlFor="manual-root">Windows 绝对路径</label><div className="input-with-action"><input id="manual-root" value={path} onChange={event=>setPath(event.target.value)} placeholder="例如 D:\\工作资料\\项目" onKeyDown={event=>{if(event.key==='Enter')void add();}}/><button className="btn btn-dark" onClick={()=>void add()} disabled={adding||!path.trim()}>{adding?<LoaderCircle size={15} className="spin"/>:<ArrowRight size={15}/>}添加授权</button></div><small>仅接受本地磁盘目录；UNC、设备路径、符号链接目标和路径越界会被拒绝。</small></div></div>
      <div className="section-title-row"><div><h3>授权列表 <span className="count-badge">{roots.length}</span></h3><p>每次文件访问都会重新验证目录状态</p></div><button className="icon-btn" onClick={refresh}><RefreshCw size={16}/></button></div>
      <div className="roots-list">{roots.length?roots.map(root=><div className="root-card" key={root.id}><div className="root-leading"><div className={`root-folder-icon ${root.enabled&&root.accessible?'':'inactive'}`}><Folder size={19}/></div><div className="root-info"><div className="root-name-row"><strong>{root.name}</strong><span className={`state-pill tiny ${root.enabled&&root.accessible?'connected':!root.enabled?'stopped':'auth_error'}`}><i/>{!root.enabled?'已暂停':root.accessible?'可访问':'需检查'}</span></div><div className="root-path" title={root.path}>{root.path}</div>{root.issue&&<div className="root-issue"><AlertCircle size={13}/>{root.issue}</div>}<div className="root-meta"><span><HardDrive size={13}/>Windows 本地目录</span><span><LockKeyhole size={13}/>只读</span></div></div></div><div className="root-controls"><button className="btn btn-sm btn-soft" onClick={()=>onAction(root.id,'test')} disabled={busy===`root-${root.id}`}><CheckCircle2 size={14}/>测试</button><button className="btn btn-sm btn-ghost" onClick={()=>onAction(root.id,'toggle',!root.enabled)} disabled={busy===`root-${root.id}`}><span className={`switch ${root.enabled?'on':''}`}><i/></span>{root.enabled?'暂停':'启用'}</button><button className="icon-btn danger-hover" title="删除授权" onClick={()=>onAction(root.id,'delete')} disabled={busy===`root-${root.id}`}><Trash2 size={16}/></button></div></div>):<EmptyState icon={FolderOpen} title="还没有授权目录" description="选择一个范围较小的本地文件夹，作为 MCP 可读取的根目录。"/>}</div>
    </div>
    <div className="roots-aside"><div className="panel safe-panel"><div className="panel-heading"><span className="panel-icon teal"><ShieldCheck size={17}/></span><div><h3>Windows 文件访问</h3><p>目录授权如何保护本机数据</p></div></div><div className="safe-steps"><div><i>01</i><span><b>显式授权</b><small>只加入你选择的文件夹</small></span></div><div><i>02</i><span><b>每次重新校验</b><small>检查目录开关、句柄最终路径与 ACL</small></span></div><div><i>03</i><span><b>拒绝特殊路径</b><small>拒绝 UNC、备用数据流、符号链接和越界路径</small></span></div></div><div className="safe-footnote"><LockKeyhole size={14}/> 文件正文仅在 MCP 工具被调用时读取</div></div><div className="tip-card"><span className="tip-icon"><BookOpen size={18}/></span><div><b>建议先用测试目录</b><p>选择仅包含非敏感文件的小型目录，测试完成后再添加其他授权。</p></div></div></div>
  </div>;
}

function FilesPage({roots,call,notify}:{roots:Root[];call:<T,>(url:string,init?:RequestInit)=>Promise<T>;notify:(message:string,error?:boolean)=>void}) {
  const available=roots.filter(root=>root.enabled&&root.accessible);
  const [rootId,setRootId]=useState(''); const [currentPath,setCurrentPath]=useState(''); const [pathInput,setPathInput]=useState('');
  const [entries,setEntries]=useState<Entry[]>([]); const [totalEntries,setTotalEntries]=useState(0); const [pageOffset,setPageOffset]=useState(0); const [nextOffset,setNextOffset]=useState<number|null>(null); const [loading,setLoading]=useState(false); const [selected,setSelected]=useState<Entry|null>(null); const [preview,setPreview]=useState<Record<string,unknown>|null>(null); const [previewBusy,setPreviewBusy]=useState(false);
  const [filter,setFilter]=useState(''); const [refreshKey,setRefreshKey]=useState(0);
  useEffect(()=>{if(!available.some(root=>root.id===rootId)){setRootId(available[0]?.id??'');setCurrentPath('');setSelected(null);}},[available.map(x=>`${x.id}:${x.enabled}:${x.accessible}`).join('|')]);
  useEffect(()=>{if(!rootId)return;let live=true;setLoading(true);const query=new URLSearchParams({rootId,path:currentPath,offset:String(pageOffset),limit:'100'});call<{entries:Entry[];total_entries:number;next_offset:number|null}>('/api/files?'+query.toString()).then(data=>{if(live){setEntries(data.entries);setTotalEntries(data.total_entries);setNextOffset(data.next_offset);}}).catch(error=>{if(live)notify(error instanceof Error?error.message:'目录读取失败',true);}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};},[rootId,currentPath,pageOffset,refreshKey]);
  const shown=entries.filter(entry=>!filter||entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  const open=async(entry:Entry)=>{if(entry.type==='directory'){setCurrentPath(entry.path);setPathInput(entry.path);setPageOffset(0);setSelected(null);setPreview(null);return;}setSelected(entry);setPreview(null);setPreviewBusy(true);try{const q=new URLSearchParams({rootId,path:entry.path});const data=await call<Record<string,unknown>>('/api/files/preview?'+q.toString());setPreview(data);}catch(e){setPreview({error:e instanceof Error?e.message:'无法预览该文件'});}finally{setPreviewBusy(false);}};
  const goPath=()=>{setCurrentPath(pathInput);setPageOffset(0);setSelected(null);setPreview(null);};
  const up=()=>{if(!currentPath)return;const path=currentPath.split('/').slice(0,-1).join('/');setCurrentPath(path);setPathInput(path);setPageOffset(0);};
  const copy=async(entry:Entry)=>{try{const q=new URLSearchParams({rootId,path:entry.path});const data=await call<{path:string}>('/api/files/absolute-path?'+q.toString());await navigator.clipboard.writeText(data.path);notify('绝对路径已复制');}catch(e){notify(e instanceof Error?e.message:'复制路径失败',true);}};
  const crumbs=['',...currentPath.split('/').filter(Boolean)].map((part,index,all)=>({label:part||'根目录',path:all.slice(1,index+1).join('/')}));
  return <div className="file-manager">
    <div className="file-toolbar"><div className="file-select-wrap"><span className="toolbar-label">授权目录</span><div className="select-box"><Folder size={16}/><select value={rootId} onChange={event=>{setRootId(event.target.value);setCurrentPath('');setPathInput('');setPageOffset(0);setSelected(null);setPreview(null);}}><option value="">选择目录…</option>{available.map(root=><option value={root.id} key={root.id}>{root.name} — {root.path}</option>)}</select><ChevronDown size={15}/></div></div><div className="file-toolbar-actions"><button className="icon-btn" onClick={up} disabled={!currentPath} title="返回上一级"><ArrowUp size={17}/></button><button className="icon-btn" onClick={()=>setRefreshKey(value=>value+1)} disabled={!rootId} title="刷新"><RefreshCw size={16}/></button><div className="toolbar-divider"/><div className="search-field"><Search size={15}/><input value={filter} onChange={event=>setFilter(event.target.value)} placeholder="筛选当前目录"/></div></div></div>
    <div className="path-bar"><div className="breadcrumbs">{crumbs.map((crumb,index)=><span key={crumb.path||'root'}><button className={index===crumbs.length-1?'current':''} onClick={()=>{setCurrentPath(crumb.path);setPathInput(crumb.path);setPageOffset(0);}}>{index===0?<Home size={14}/>:crumb.label}</button>{index<crumbs.length-1&&<ChevronRight size={13}/>}</span>)}</div><div className="path-jump"><input value={pathInput} onChange={event=>setPathInput(event.target.value)} onKeyDown={event=>{if(event.key==='Enter')goPath();}} placeholder="输入授权目录内的相对路径"/><button onClick={goPath}>跳转 <ArrowRight size={14}/></button></div></div>
    {!available.length?<EmptyState icon={FolderOpen} title="没有可浏览的目录" description="请先在“目录授权”页面添加并启用本地文件夹。" action={<button className="btn btn-primary" onClick={()=>notify('请先打开目录授权页面添加一个本地目录。')}>了解</button>}/>:<div className={`explorer-layout ${selected?'has-preview':''}`}>
      <div className="explorer-panel"><div className="table-head"><span>名称</span><span>类型</span><span>大小</span><span>修改时间</span></div><div className="file-rows">{loading?<div className="list-loading"><LoaderCircle className="spin" size={20}/> 正在读取目录元数据…</div>:shown.length?shown.map((entry,index)=><button className={`file-row ${selected?.path===entry.path?'selected':''}`} key={`${entry.path}-${index}`} onClick={()=>void open(entry)} onDoubleClick={()=>{if(entry.type==='file')void open(entry);}}><span className="file-name"><FileIcon entry={entry}/><b title={entry.name}>{entry.name}</b>{entry.image_metadata_only&&<span className="image-mark" title="仅显示元数据"><FileImage size={12}/></span>}{entry.type==='blocked_reparse'&&<span className="blocked-mark">已阻止</span>}</span><span className="file-type">{entry.type==='directory'?'文件夹':entry.type==='blocked_reparse'?'特殊路径':entry.extension||'文件'}</span><span className="file-size">{entry.type==='directory'?'—':formatBytes(entry.size_bytes)}</span><span className="file-date">{entry.modified_iso?new Date(entry.modified_iso).toLocaleString('zh-CN',{dateStyle:'short',timeStyle:'short'}):'—'}</span></button>):<div className="empty-table"><FolderOpen size={22}/><strong>{filter?'没有匹配项':'当前目录为空'}</strong><span>{filter?'尝试其他筛选词。':'此授权目录中没有可显示的项目。'}</span></div>}</div><div className="table-footer"><span>显示 {totalEntries===0?0:pageOffset+1}–{pageOffset+entries.length} / {totalEntries} 项{filter?` · 本页匹配 ${shown.length} 项`:''}</span><div className="table-pager"><button className="btn btn-outline btn-sm" onClick={()=>setPageOffset(value=>Math.max(0,value-100))} disabled={loading||pageOffset===0}><ArrowLeft size={13}/>上一页</button><button className="btn btn-outline btn-sm" onClick={()=>setPageOffset(nextOffset??pageOffset)} disabled={loading||nextOffset===null}>下一页<ArrowRight size={13}/></button></div><span><ShieldCheck size={13}/>只读浏览</span></div></div>
      {selected&&<aside className="preview-panel"><div className="preview-header"><div><span className="preview-label">文件预览</span><h3 title={selected.name}>{selected.name}</h3></div><button className="icon-btn" onClick={()=>{setSelected(null);setPreview(null);}} aria-label="关闭预览"><X size={16}/></button></div><div className="preview-path">{selected.path}</div><div className="preview-meta"><span>{selected.extension.toUpperCase()||'FILE'}</span><span>{formatBytes(selected.size_bytes)}</span><span>{selected.modified_iso?new Date(selected.modified_iso).toLocaleDateString('zh-CN'):'未知日期'}</span></div><button className="copy-path-btn" onClick={()=>void copy(selected)}><Clipboard size={14}/>复制绝对路径</button><div className="preview-body">{previewBusy?<div className="preview-loading"><LoaderCircle size={20} className="spin"/>读取预览…</div>:preview?.error?<div className="preview-error"><AlertCircle size={17}/><span>{String(preview.error)}</span></div>:preview?<><div className="preview-note"><FileText size={13}/>只显示文本，不包含图片或二进制正文</div><pre>{String(preview.text??JSON.stringify(preview,null,2))}</pre>{Boolean(preview.has_more)&&<div className="preview-truncated"><ArrowDown size={14}/>预览仅显示前一页</div>}</>:<div className="preview-loading">选择文件以显示预览</div>}</div></aside>}
    </div>}
    <div className="file-manager-footer"><span><LockKeyhole size={14}/>所有文件操作均限制在所选授权根内</span><span>路径范围：{currentPath||'/'}</span></div>
  </div>;
}

function LogsPage({logs,call,notify,refresh}:{logs:LogEntry[];call:<T,>(url:string,init?:RequestInit)=>Promise<T>;notify:(message:string,error?:boolean)=>void;refresh:()=>void}) {
  const [query,setQuery]=useState('');const [kind,setKind]=useState('all');const filtered=logs.filter(log=>(kind==='all'||(kind==='error'?log.error:log.kind===kind))&&(!query||`${log.kind} ${log.message}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  const clear=async()=>{try{await call('/api/logs',{method:'DELETE'});notify('运行日志已清空');refresh();}catch(e){notify(e instanceof Error?e.message:'清空日志失败',true);}};
  return <div className="logs-layout"><div className="logs-summary"><div><span className="panel-icon blue"><Activity size={17}/></span><div><strong>{logs.length}</strong><span>保存的本地事件</span></div></div><div><span className="panel-icon teal"><ShieldCheck size={17}/></span><div><strong>已脱敏</strong><span>凭据与正文不写入日志</span></div></div><div><span className="panel-icon violet"><Clock3 size={17}/></span><div><strong>{logs[0]?new Date(logs[0].time).toLocaleTimeString('zh-CN'):'—'}</strong><span>最近事件时间</span></div></div></div><div className="logs-card"><div className="logs-toolbar"><div><h3>事件记录</h3><p>日志在本机持久化，最多保留最近 300 条。</p></div><div className="logs-controls"><div className="search-field"><Search size={15}/><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="搜索日志"/></div><select value={kind} onChange={event=>setKind(event.target.value)}><option value="all">所有事件</option><option value="error">仅错误</option>{[...new Set(logs.map(log=>log.kind))].map(item=><option key={item} value={item}>{item}</option>)}</select><button className="btn btn-outline" onClick={refresh}><RefreshCw size={14}/>刷新</button><button className="btn btn-danger-outline" onClick={()=>void clear()}><Trash2 size={14}/>清空</button></div></div><div className="log-table-head"><span aria-hidden="true"/><span>时间</span><span>类型</span><span>事件</span><span>耗时 / 字节</span></div><div className="log-rows">{filtered.length?filtered.map(log=><ActivityRow key={log.id} log={log} expanded/>):<EmptyState icon={Activity} title="没有匹配的日志" description="调整筛选条件，或启动 Tunnel 查看连接事件。"/>}</div><div className="logs-bottom"><span>显示 {filtered.length} / {logs.length} 条</span><span><i className="live-dot"/>本地持久化日志</span></div></div></div>;
}

function SettingsPage({snapshot,busy,call,notify,mutate,refresh}:{snapshot:Snapshot;busy:string|null;call:<T,>(url:string,init?:RequestInit)=>Promise<T>;notify:(message:string,error?:boolean)=>void;mutate:(name:string,action:()=>Promise<unknown>,success:string)=>Promise<void>;refresh:()=>void}) {
  const [settings,setSettings]=useState(snapshot.settings);const [runtimeKey,setRuntimeKey]=useState('');const [mcpBearer,setMcpBearer]=useState('');const [showBearer,setShowBearer]=useState(false);const [saved,setSaved]=useState(false);const [diagnostic,setDiagnostic]=useState<{tunnel:string;mcp:string;chatgpt:string}|null>(null);const [expanded,setExpanded]=useState(false);
  useEffect(()=>{setSettings(snapshot.settings);},[JSON.stringify(snapshot.settings)]);
  const save=async()=>mutate('settings-save',async()=>{await call('/api/settings',{method:'POST',body:JSON.stringify(settings)});setSaved(true);setTimeout(()=>setSaved(false),2000);},'设置已保存');
  const credential=async(name:'runtimeApiKey'|'mcpBearer',value:string)=>{if(!value.trim())return;await mutate(`credential-${name}`,async()=>{await call(`/api/credentials/${name}`,{method:'POST',body:JSON.stringify({secret:value})});if(name==='runtimeApiKey')setRuntimeKey('');else setMcpBearer('');},'密钥已保存到 Windows Credential Manager');};
  const clearCredential=async(name:'runtimeApiKey'|'mcpBearer')=>mutate(`credential-clear-${name}`,async()=>{await call(`/api/credentials/${name}`,{method:'DELETE'});},'密钥已从 Windows Credential Manager 清除');
  const test=async()=>{await mutate('settings-test',async()=>{const result=await call<typeof diagnostic>('/api/tunnel/test',{method:'POST'});setDiagnostic(result);},'Tunnel 认证与本地 MCP 测试通过');};
  const change=(key:keyof Settings,value:unknown)=>setSettings(current=>({...current,[key]:value}));
  return <div className="settings-layout"><div className="settings-main">
    <section className="settings-card"><div className="settings-section-title"><span className="settings-icon blue"><CloudCog size={18}/></span><div><h3>Secure MCP Tunnel</h3><p>连接到 OpenAI 官方 Secure MCP Tunnel 控制平面</p></div><span className={`settings-connection ${snapshot.tunnel.tunnelState.toLowerCase()}`}><i/>{stateLabel(snapshot.tunnel.tunnelState)}</span></div><div className="settings-grid"><label className="field"><span>连接器名称</span><input value={settings.pluginName} maxLength={48} onChange={event=>change('pluginName',event.target.value)}/><small>显示在 MCP 工具信息中</small></label><label className="field"><span>Tunnel ID</span><input className="mono" value={settings.tunnelId} onChange={event=>change('tunnelId',event.target.value)} placeholder="tunnel_…"/><small>从 OpenAI Platform Tunnels 页面复制</small></label></div>
      <div className="credential-row"><div className="credential-label"><span className="credential-icon"><KeyRound size={17}/></span><div><b>Runtime API Key</b><small>{snapshot.credentials.hasRuntimeApiKey?'已保存；页面不会读取密钥明文':'尚未配置凭据'}</small></div><span className={`credential-status ${snapshot.credentials.hasRuntimeApiKey?'present':''}`}><i/>{snapshot.credentials.hasRuntimeApiKey?'安全存储中':'未配置'}</span></div><div className="secret-input-row"><input type="password" autoComplete="new-password" value={runtimeKey} onChange={event=>setRuntimeKey(event.target.value)} placeholder={snapshot.credentials.hasRuntimeApiKey?'输入新密钥以替换':'输入 Runtime API Key'}/><button className="btn btn-primary btn-sm" onClick={()=>void credential('runtimeApiKey',runtimeKey)} disabled={!runtimeKey.trim()||busy==='credential-runtimeApiKey'}>{busy==='credential-runtimeApiKey'?<LoaderCircle className="spin" size={14}/>:<LockKeyhole size={14}/>}安全保存</button>{snapshot.credentials.hasRuntimeApiKey&&<button className="btn btn-danger-outline btn-sm" onClick={()=>void clearCredential('runtimeApiKey')} disabled={busy==='credential-clear-runtimeApiKey'}>清除密钥</button>}</div></div>
      <div className="credential-row"><div className="credential-label"><span className="credential-icon"><ShieldCheck size={17}/></span><div><b>MCP Bearer <em>可选</em></b><small>启用后，MCP 工具请求需要提供相同 Bearer</small></div><span className={`credential-status ${snapshot.credentials.hasMcpBearer?'present':''}`}><i/>{snapshot.credentials.hasMcpBearer?'安全存储中':'已关闭'}</span></div><div className="secret-input-row"><input type={showBearer?'text':'password'} autoComplete="new-password" value={mcpBearer} onChange={event=>setMcpBearer(event.target.value)} placeholder={snapshot.credentials.hasMcpBearer?'输入新值以替换':'输入可选 MCP Bearer'}/><button className="btn btn-outline btn-sm" onClick={()=>setShowBearer(value=>!value)}>{showBearer?'隐藏':'显示输入'}</button><button className="btn btn-primary btn-sm" onClick={()=>void credential('mcpBearer',mcpBearer)} disabled={!mcpBearer.trim()||busy==='credential-mcpBearer'}><LockKeyhole size={14}/>安全保存</button>{snapshot.credentials.hasMcpBearer&&<button className="btn btn-danger-outline btn-sm" onClick={()=>void clearCredential('mcpBearer')}>清除</button>}</div></div>
      <div className="settings-actions"><button className="btn btn-outline" onClick={()=>void test()} disabled={busy!==null}><Activity size={15}/>测试配置</button><button className="btn btn-primary" onClick={()=>void save()} disabled={busy!==null}>{saved?<Check size={15}/>:<CheckCircle2 size={15}/>}保存设置</button></div>{diagnostic&&<div className="diagnostic-result"><CheckCircle2 size={16}/><div><b>{diagnostic.tunnel}</b><span>{diagnostic.mcp} · {diagnostic.chatgpt}</span></div></div>}</section>
    <section className="settings-card"><div className="settings-section-title"><span className="settings-icon teal"><Activity size={18}/></span><div><h3>运行与资源限制</h3><p>调整自动重连、超时与单次读取上限</p></div></div><div className="settings-grid"><label className="field"><span>网络超时</span><div className="unit-input"><input type="number" min={10} max={120} value={settings.networkTimeoutSeconds} onChange={event=>change('networkTimeoutSeconds',Number(event.target.value))}/><span>秒</span></div><small>请求与命令处理最长等待时间</small></label><label className="field"><span>单文件读取限制</span><div className="unit-input"><input type="number" min={1} max={64} value={Math.round(settings.maxReadBytes/1024/1024)} onChange={event=>change('maxReadBytes',Number(event.target.value)*1024*1024)}/><span>MiB</span></div><small>限制文本读取与文档解析</small></label><label className="field"><span>单文件累计字符限制</span><div className="unit-input"><input type="number" min={1} max={20} value={Math.round(settings.maxReadChars/1_000_000)} onChange={event=>change('maxReadChars',Number(event.target.value)*1_000_000)}/><span>百万字符</span></div></label><label className="field"><span>单次输出字符限制</span><div className="unit-input"><input type="number" min={4096} max={262144} step={4096} value={settings.maxOutputChars} onChange={event=>change('maxOutputChars',Number(event.target.value))}/><span>字符</span></div></label></div><div className="preference-row"><div><b>自动重连</b><small>网络中断或短时服务错误时，使用指数退避重试</small></div><button className={`switch ${settings.autoReconnect?'on':''}`} onClick={()=>change('autoReconnect',!settings.autoReconnect)} role="switch" aria-checked={settings.autoReconnect}><i/></button></div><div className="preference-row"><div><b>详细日志</b><small>记录更多连接阶段信息，不记录密钥或文件正文</small></div><button className={`switch ${settings.debugLogging?'on':''}`} onClick={()=>change('debugLogging',!settings.debugLogging)} role="switch" aria-checked={settings.debugLogging}><i/></button></div></section>
    <section className="settings-card"><div className="settings-section-title"><span className="settings-icon violet"><Sun size={18}/></span><div><h3>外观主题</h3><p>选择与 Windows 桌面搭配的界面主题</p></div></div><div className="theme-options">{(['system','light','dark'] as const).map((theme,index)=><button key={theme} className={`theme-option ${settings.theme===theme?'selected':''}`} onClick={()=>change('theme',theme)}><span className={`theme-preview theme-preview-${theme}`}><i/><i/><i/></span><b>{['跟随系统','浅色','深色'][index]}</b>{settings.theme===theme&&<Check size={15}/>}</button>)}</div><div className="theme-save-row"><span>主题会在保存设置后应用。</span><button className="btn btn-primary btn-sm" onClick={()=>void save()} disabled={busy!==null}>保存主题</button></div></section>
  </div><aside className="settings-aside"><div className="settings-side-card secure-card"><span className="secure-illustration"><LockKeyhole size={23}/><i/><i/><i/></span><h3>凭据存储在<br/>Windows Credential Manager</h3><p>Runtime API Key 和可选 MCP Bearer 使用当前 Windows 用户凭据库保存。Web 页面无法重新读取密钥明文。</p><div className="secure-status"><CheckCircle2 size={15}/>安全存储可用</div></div><div className="settings-side-card chatgpt-card"><div className="chatgpt-head"><span className="panel-icon blue"><CircleHelp size={17}/></span><div><h3>ChatGPT 配置说明</h3><p>完成后在 ChatGPT 网页注册连接器</p></div><button className="icon-btn" onClick={()=>setExpanded(value=>!value)}>{expanded?<ChevronDown size={16}/>:<ChevronRight size={16}/>}</button></div>{expanded&&<div className="chatgpt-steps"><p>1. 在 OpenAI Platform 创建 Secure MCP Tunnel 与 Runtime API Key。</p><p>2. 保存 Tunnel ID 与密钥，然后在目录页授权一个小型测试文件夹。</p><p>3. 启动 WinCodex Tunnel。这里的“已连接”只表示本机轮询到控制平面。</p><p>4. 在 ChatGPT 网页的连接器设置中添加自定义 MCP Tunnel，并选择相同 Tunnel。</p><p>5. 从新对话手动选择连接器并请求读取测试文件，以验证端到端链路。</p><div className="warning-note"><AlertCircle size={14}/>此应用无法通过 Tunnel API 确认 ChatGPT 是否注册成功。</div></div>}<a href="https://platform.openai.com/settings/organization/tunnels" target="_blank" rel="noreferrer">打开 Platform Tunnels <ArrowRight size={14}/></a></div><div className="settings-side-card app-version"><span className="brand-mark small"><Code2 size={15}/></span><div><b>WinCodex</b><small>Windows Web MCP Bridge · 0.1.0</small></div><span className="version-dot"/></div></aside></div>;
}

function LoadingPanel({error,onRetry}:{error:string;onRetry:()=>void}) {return <div className="loading-screen"><div className="loading-mark"><Code2 size={24}/></div>{error?<><h2>连接本地服务失败</h2><p>{error}</p><button className="btn btn-primary" onClick={onRetry}><RefreshCw size={15}/>重新连接</button><small>请确认 WinCodex 后台服务仍在运行。</small></>:<><LoaderCircle className="spin" size={24}/><h2>正在连接 WinCodex</h2><p>读取本机运行状态…</p></>}</div>}
function EmptyState({icon:Icon,title,description,action}:{icon:typeof Home;title:string;description:string;action?:React.ReactNode}) {return <div className="empty-state"><span><Icon size={23}/></span><strong>{title}</strong><p>{description}</p>{action}</div>}
function StatCard({icon:Icon,label,value,detail,tone,action}:{icon:typeof Home;label:string;value:string;detail:string;tone:string;action:()=>void}) {return <button className="stat-card" onClick={action}><span className={`stat-icon ${tone}`}><Icon size={18}/></span><span className="stat-label">{label}</span><strong>{value}</strong><small>{detail}</small><ArrowRight className="stat-arrow" size={15}/></button>}
function ActivityRow({log,expanded=false}:{log:LogEntry;expanded?:boolean}) {return <div className={`activity-row ${log.error?'is-error':''} ${expanded?'expanded':''}`}><span className={`activity-symbol ${log.error?'error':log.kind.includes('读取')?'read':log.kind.includes('连接')?'connection':'default'}`}>{log.error?<AlertCircle size={15}/>:log.kind.includes('读取')?<FileText size={15}/>:log.kind.includes('连接')?<Network size={15}/>:<Activity size={15}/>}</span><span className="activity-main"><b>{log.kind}</b><span title={log.message}>{log.message}</span></span><span className="activity-time">{new Date(log.time).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:expanded?'2-digit':undefined})}</span>{(log.durationMs!==undefined||log.bytes!==undefined)&&<span className="activity-metric">{log.durationMs!==undefined?`${log.durationMs} ms`:''}{log.bytes!==undefined?` · ${formatBytes(log.bytes)}`:''}</span>}</div>}
function FileIcon({entry}:{entry:Entry}) {if(entry.type==='directory')return <span className="file-icon folder"><Folder size={17}/></span>;if(entry.type==='blocked_reparse')return <span className="file-icon blocked"><LockKeyhole size={16}/></span>;if(entry.image_metadata_only)return <span className="file-icon image"><FileImage size={16}/></span>;if(['pdf','docx','xlsx','pptx','md','txt'].includes(entry.extension))return <span className="file-icon doc"><FileText size={16}/></span>;if(['js','ts','json','py','kt','java','xml','css'].includes(entry.extension))return <span className="file-icon code"><FileCode2 size={16}/></span>;return <span className="file-icon generic"><File size={16}/></span>;}
function themeClass(theme:Theme){if(theme==='dark')return 'theme-dark';if(theme==='light')return 'theme-light';return 'theme-system';}
function pageDescription(page:Page){return ({home:'监控本机 MCP 服务、授权范围与 Tunnel 连接。',roots:'通过 Windows 文件夹选择器添加明确的只读访问范围。',files:'浏览已授权目录中的文件，查看安全的文本与文档预览。',logs:'查看连接、文件访问和 MCP 请求的本地脱敏记录。',settings:'管理 Tunnel 凭据、读取上限、重连策略与界面主题。'})[page];}
function stateLabel(state:TunnelState){return ({STOPPED:'已停止',STARTING:'正在连接',CONNECTED:'已连接',DISCONNECTED:'连接中断',AUTH_ERROR:'需要检查凭据',SERVICE_ERROR:'服务异常'})[state];}
function formatNumber(value:number){return new Intl.NumberFormat('zh-CN').format(value);}
function formatBytes(value:number){if(!Number.isFinite(value)||value<0)return '—';if(value<1024)return `${value} B`;const units=['KiB','MiB','GiB'];let size=value/1024;let index=0;while(size>=1024&&index<units.length-1){size/=1024;index++;}return `${size.toFixed(size>=10?1:2)} ${units[index]}`;}
