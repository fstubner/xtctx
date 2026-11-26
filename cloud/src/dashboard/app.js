const $=id=>document.getElementById(id);
let view='browse',overview=null,nextSessions=null,currentSession=null,nextMessages=null,listEpoch=0,readerEpoch=0,sessionEpoch=0;
const format=n=>Number(n||0).toLocaleString();
const date=s=>s?new Date(s).toLocaleString():"Not reported";
function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
function error(message){$('error').textContent=message;$('error').hidden=!message;}
function signedOut(){sessionEpoch++;listEpoch++;readerEpoch++;for(const id of ['stats','providers','uploads','source-coverage','attention-items','projects-table','skills-list'])$(id).replaceChildren();$('project').replaceChildren(option('','All projects'));$('provider').replaceChildren(option('','All sources'));$('query').value='';$('token-value').textContent='';$('token-box').hidden=true;$('token-note').hidden=true;$('billing-banner').hidden=true;$('app').hidden=true;$('login').hidden=false;currentSession=null;nextSessions=null;nextMessages=null;$('sessions').replaceChildren();$('reader').replaceChildren();overview=null;$('attention-count').hidden=true;}
async function api(path,options={}){const response=await fetch('/dashboard/'+path,{credentials:'same-origin',cache:'no-store',...options});if(response.status===401&&path!=='login'){signedOut();throw Error('Your session expired. Sign in with GitHub to continue.');}let data;try{data=await response.json();}catch{throw Error('The server returned an unreadable response.');}if(!response.ok){throw Error(data.error==='github_sign_in_not_configured'?'GitHub sign-in is not configured on this xtctx server yet.':data.error==='subscription_required'?'An active subscription is required to browse synced transcripts.':data.error==='search_unavailable'?'Search is unavailable or busy. Try again shortly.':'Could not complete the request ('+(data.error||response.status)+').');}return data;}
function option(value,text){const o=el('option',text);o.value=value;return o;}
const sourceNames={'claude-code':'Claude Code','chatgpt-web':'ChatGPT web','claude-web':'Claude web','gemini-web':'Gemini web','antigravity':'Antigravity','codex':'Codex','hermes':'Hermes','hermes-main':'Hermes (main)','hermes-worker':'Hermes (worker)','cursor':'Cursor','copilot':'Copilot','copilot-cli':'Copilot CLI','opencode':'OpenCode','github':'GitHub'};
const sourceName=tool=>sourceNames[tool]||tool;
const projectName=name=>['local-session-archive','web-history','xtctx-local-session-archive','xtctx-hermes-history'].includes(name)?name+' (archive)':name;
const evidenceLabel=value=>({not_checked:'Not checked',not_detected:'Store not detected',inaccessible:'Inaccessible',unsupported:'Unsupported',detected:'Store detected'}[value]||value);
function scopeLabel(){const selected=id=>$(id).selectedOptions[0]?.textContent||'';const search=$('query').value.trim();$('active-scope').textContent=selected('project')+' · '+(search?'All sources searched':selected('provider'))+(search?' · '+$('mode').value+' search':'');$('provider').disabled=Boolean(search);$('provider').title=search?'Source filtering is available while browsing. Search currently spans all sources in the selected project.':'';}
function clearReader(){for(const row of $('sessions').children)row.setAttribute('aria-pressed','false');currentSession=null;nextMessages=null;readerEpoch++;document.querySelector('.workspace').classList.remove('reader-open');$('reader').replaceChildren();const box=el('div',undefined,'reader-empty');box.append(el('div','↳','empty-symbol'),el('p','YOUR NEXT THREAD','eyebrow'),el('h2','A conversation worth returning to.'),el('p','Choose a result to read the original messages. Source details and saved revisions stay close by.'));$('reader').append(box);}
function coverageRows(result){
 const rows=new Map();const key=(d,s,c='main')=>d+'|'+s+'|'+c;
 for(const old of result.source_coverage||[])rows.set(key(old.device_id,old.source),{device:old.device_name,source:old.source,scope:'main',legacy:old});
 for(const item of result.coverage_evidence||[]){const id=key(item.device_id,item.source,item.scope);const row=rows.get(id)||{device:item.device_name,source:item.source,scope:item.scope};try{row[item.kind]=JSON.parse(item.evidence_json);}catch{}rows.set(id,row);}
 const devices=new Map();for(const item of [...result.source_coverage||[],...result.coverage_evidence||[]])devices.set(item.device_id,item.device_name);
 const sources=['claude-code','codex','cursor','copilot','copilot-cli','antigravity','opencode','chatgpt-web','claude-web','gemini-web'];
 for(const [id,name]of devices)for(const source of sources){if(![...rows.keys()].some(k=>k.startsWith(id+'|'+source+'|')))rows.set(key(id,source),{device:name,source,scope:'main'});}
 return [...rows.values()].sort((a,b)=>a.device.localeCompare(b.device)||a.source.localeCompare(b.source)||a.scope.localeCompare(b.scope));
}
function staleEvidence(e){return Boolean(e)&&(!Number.isFinite(Date.parse(e.checked_at))||Date.now()-Date.parse(e.checked_at)>3600000);}
function attention(rows){
 const issues=rows.filter(r=>!r.inventory||staleEvidence(r.inventory)||staleEvidence(r.reconciliation)||staleEvidence(r.browser)||r.inventory.state!=='not_detected'&&(r.inventory.state!=='detected'||!r.reconciliation||r.reconciliation.text_parity!=='verified'||r.reconciliation.missing_sessions>0));
 $('attention-count').hidden=!issues.length;$('attention-count').textContent=String(issues.length);
 const items=issues.slice(0,5).map(r=>{const box=el('div',undefined,'attention-item');const text=el('div');text.append(el('strong',r.device+' · '+sourceName(r.source)),el('p',staleEvidence(r.inventory)||staleEvidence(r.reconciliation)||staleEvidence(r.browser)?'This evidence is over an hour old; a fresh check is needed.':r.legacy&&!r.inventory?'Legacy check: verification date unknown.':!r.inventory?'No source inventory reported.':r.inventory.state==='detected'?'Source detected; full text verification is not established.':'Inventory: '+r.inventory.state));box.append(text,el('span','Needs verification','status-label'));return box;});
 if(issues.length>5)items.push(el('p',format(issues.length-5)+' more checks are listed below.','muted'));
 items.push(el('p','Original attachments remain unverified. Browser receipts cover only the account or organization selected during import.','muted'));$('attention-items').replaceChildren(...items);
 $('source-coverage').replaceChildren(...rows.map(r=>{const tr=el('tr');const c=r.collection,i=r.inventory,v=r.reconciliation,b=r.browser;const counts=v?'Matched '+(v.matched_sessions??'Unknown')+' · missing '+(v.missing_sessions??'Unknown')+' · retained '+(v.retained_sessions??'Unknown')+' · excluded '+(i?.excluded_sessions??'Unknown'):b?'Listed '+(b.listed_sessions??'Unknown')+' · indexed for this account: Unknown':'Discovered '+(i?.discovered_sessions??'Unknown')+' / stored '+(c?.indexed_sessions??r.legacy?.indexed_sessions??'Unknown');const values=[r.device+' / '+sourceName(r.source)+(r.scope==='main'?'':' · '+r.scope.slice(0,18)+'…'),evidenceLabel(i?.state)||(b?'Selected listing: '+b.state:r.legacy?'Legacy check—verification unknown':'Not checked'),counts,c?'Counted '+date(c.checked_at)+' · '+format(c.indexed_messages)+' rows · collection completed '+(c.completed_at?date(c.completed_at):'Unknown'):r.legacy?'Legacy receipt '+date(r.legacy.observed_at):'Not reported',i?(staleEvidence(i)?'Stale · ':'')+date(i.checked_at):b?(staleEvidence(b)?'Stale · ':'')+'Listing checked '+date(b.checked_at):'Not checked',v?(staleEvidence(v)?'Stale · ':'')+v.text_parity+' · '+date(v.checked_at):'Not verified'];for(const value of values)tr.append(el('td',value));return tr;}));
}

function renderBillingAndProjects(result,totalMessages){
 const b=result.billing||{allowed:true,billing_enabled:false,status:'allowlisted',message_quota:null};
 const statusText={allowlisted:'Allowlisted (free)',active:'Active subscription',trialing:'14-day trial active',past_due:'Payment past due',canceled:'Canceled',none:'No active plan'}[b.status]||b.status;
 $('billing-status').textContent=b.billing_enabled?statusText:'Self-hosted (open)';
 $('billing-quota').textContent=b.message_quota?format(totalMessages)+' / '+format(b.message_quota)+' hosted messages indexed':'Unlimited hosted messages · '+format(totalMessages)+' indexed';
 $('subscribe-btn').hidden=!(b.billing_enabled&&!b.allowed);
 $('portal-btn').hidden=!(b.billing_enabled&&b.stripe_customer_id);
 $('billing-banner').hidden=!(b.billing_enabled&&!b.allowed);
 $('mint-token').disabled=!b.allowed;
 const semanticOpt=$('mode').querySelector('option[value="semantic"]');
 if(semanticOpt)semanticOpt.textContent=result.semantic_search_available===false?'Semantic (worker not enabled)':'Semantic';

 const rows=result.projects||[];
 $('projects-table').replaceChildren(...(rows.length?rows.map(p=>{
  const tr=el('tr');const tdProj=el('td');
  const jump=el('button',projectName(p.repo_url),'link-btn');jump.type='button';
  jump.addEventListener('click',()=>{if(p.repo_url!=='(no repo)')$('project').value=p.repo_url;changeView('browse');});
  tdProj.append(jump);tr.append(tdProj,el('td',format(p.sessions)),el('td',format(p.messages)),el('td',format(p.github_items)),el('td',(p.tools||'').split(',').filter(Boolean).map(sourceName).join(', ')||'Unknown'),el('td',date(p.last_activity)));
  return tr;
 }):[(()=>{const tr=el('tr');const td=el('td','No synced projects yet.');td.colSpan=6;tr.append(td);return tr;})()]));

 const skills=result.skills||[];
 $('skills-list').replaceChildren(...(skills.length?skills.map(s=>{const chip=el('span',undefined,'skill-chip');chip.append(el('span',s.name),el('strong',format(s.count)));return chip;}):[el('p','No skill invocations recorded in synced message metadata yet.','muted')]));
}
async function refresh(){const epoch=sessionEpoch;const result=await api('api/overview');if(epoch!==sessionEpoch)return;overview=result;attention(coverageRows(overview));$('login').hidden=true;$('app').hidden=false;$('account').textContent=overview.username;$('updated').textContent='Checked '+new Date().toLocaleTimeString();
 const providers=overview.providers||[],uploads=overview.uploads||[],totalMessages=providers.reduce((n,p)=>n+p.message_rows,0);
 $('stats').replaceChildren(...[[providers.reduce((n,p)=>n+p.sessions,0),'Stored sessions'],[totalMessages,'Message rows · includes revisions'],[new Set(uploads.map(p=>p.repo_url)).size,'Synced projects']].map(([n,label])=>{const d=el('div',undefined,'stat');d.append(el('strong',format(n)),el('span',label));return d;}));
 $('providers').replaceChildren(...(providers.length?providers.map(p=>{const r=el('div',undefined,'source-row');r.append(el('span',sourceName(p.tool)),el('span',format(p.sessions)+' sessions'),el('span',format(p.message_rows)+' rows'));return r;}):[el('p','No uploads yet. Opt a project into xtctx sync to start.','muted')]));
 $('uploads').replaceChildren(...uploads.map(p=>{const r=el('tr');for(const value of [p.project_name,p.device_name||'Unnamed device',format(p.sessions),date(p.last_upload_at)])r.append(el('td',value));return r;}));

 const selected=$('project').value;$('project').replaceChildren(option('','All projects'));const projects=new Map(uploads.map(p=>[p.repo_url,p.project_name]));for(const p of result.projects||[])if(p.repo_url&&p.repo_url!=='(no repo)'&&!projects.has(p.repo_url))projects.set(p.repo_url,p.repo_url);for(const [id,name]of projects)$('project').append(option(id,projectName(name)));if(projects.has(selected))$('project').value=selected;
 const provider=$('provider').value;$('provider').replaceChildren(option('','All sources'),...providers.map(p=>option(p.tool,sourceName(p.tool))));$('provider').value=provider;
 renderBillingAndProjects(overview,totalMessages);
 scopeLabel();if(view==='browse'||view==='search')if(!overview.billing||overview.billing.allowed)await list(false);else{$('sessions').replaceChildren();$('list-status').textContent='Start a trial or subscribe to view synced sessions.';}
}
function filters(){const p=new URLSearchParams();if($('project').value)p.set('repo',$('project').value);return p;}
async function list(append=false){const epoch=++listEpoch;scopeLabel();error('');$('list-status').textContent='Loading…';$('apply').disabled=true;try{
 const p=filters();let data;
 if(view==='search'){
  const q=$('query').value.trim();if(!q){$('list-status').textContent='Enter a query to search your archive.';return;}
  p.set('q',q);p.set('mode',$('mode').value);data=await api('api/search?'+p);if(epoch!==listEpoch)return;
  const c=data.coverage;$('search-status').hidden=false;$('search-status').textContent='Requested: '+$('mode').value+' · Using: '+data.effective_mode+(c?' · '+format(c.indexed_messages)+' / '+format(c.total_messages)+' messages semantically indexed'+(c.partial?' · Partial coverage':''):'')+(data.fallback?' · '+data.fallback:'');nextSessions=null;
 }else{if($('provider').value)p.set('tool',$('provider').value);p.set('offset',String(append?nextSessions||0:0));data=await api('api/sessions?'+p);if(epoch!==listEpoch)return;nextSessions=data.next;}
 const rows=view==='search'?data.matches||[]:data.sessions||[];if(!append)$('sessions').replaceChildren();
 for(const row of rows){const b=el('button',undefined,'session-row');b.type='button';b.setAttribute('aria-pressed','false');b.append(el('strong',(row.display_preview||row.excerpt||sourceName(row.tool)+' session').slice(0,160)),el('span',sourceName(row.tool)+' · '+(projectName(overview.uploads.find(p=>p.repo_url===row.repo_url)?.project_name||row.repo_url))+' · '+date(row.last_activity_at||row.timestamp),'muted'));if(row.excerpt)b.append(el('span',row.excerpt,'snippet'));b.addEventListener('click',()=>{for(const n of $('sessions').children)n.setAttribute('aria-pressed','false');b.setAttribute('aria-pressed','true');openSession(row.session_ref,false,row.message_id);});$('sessions').append(b);}
 $('list-status').textContent=rows.length?format($('sessions').children.length)+(view==='search'?' matches':' sessions shown'):'No matching conversations.';$('more-sessions').hidden=nextSessions===null;
 }catch(e){if(epoch===listEpoch){error(e.message);$('list-status').textContent='Could not load this view.';}}finally{$('apply').disabled=false;}}
function metadataRows(entries){const dl=el('dl',undefined,'metadata-grid');for(const [label,value]of entries){if(value===undefined||value===null||value==='')continue;dl.append(el('dt',label),el('dd',String(value)));}return dl;}
function sessionMetadata(s){const details=el('details');details.append(el('summary','Conversation metadata'),metadataRows([['Source',sourceName(s.tool)],['Project',s.repo_url],['First message',date(s.started_at)],['Last activity',date(s.last_activity_at)],['Archive updated',date(s.updated_at)],['Branch',s.git_branch],['Commit',s.git_commit],['Session reference',s.session_ref]]));return details;}
function messageMetadata(meta){return metadataRows([['Original message',meta.provider_message_id||meta.source_message_id],['Parent message',meta.parent_id],['Capture format',meta.sourceFormat||meta.representation],['Capture version',meta.captureversion],['Revision',meta.revision],['Inferred date',meta.timestamp_inferred===true?'Yes; source did not provide a precise date':undefined],['Completeness',meta.source_complete===false?'Source marked incomplete':undefined],['Known omissions',meta.omissions?JSON.stringify(meta.omissions):undefined]]);}
async function openSession(ref,append=false,focusMessage){const epoch=++readerEpoch;try{const data=await api('api/messages?'+new URLSearchParams({session:ref,offset:String(append?nextMessages||0:0),...(focusMessage?{focus:focusMessage}:{})}));if(epoch!==readerEpoch)return;currentSession=ref;document.querySelector('.workspace').classList.add('reader-open');nextMessages=data.next;if(!append){const actions=el('div',undefined,'reader-actions');const delBtn=el('button','Delete session','danger quiet');delBtn.type='button';delBtn.addEventListener('click',async()=>{if(!window.confirm('Delete this session and all its indexed messages from this server?'))return;delBtn.disabled=true;try{await api('api/sessions?'+new URLSearchParams({session:ref}),{method:'DELETE',headers:{Origin:window.location.origin}});clearReader();await refresh();}catch(e){error(e.message);delBtn.disabled=false;}});actions.append(delBtn);$('reader').replaceChildren(el('p',sourceName(data.session.tool)+' · '+data.session.repo_url,'eyebrow'),el('h2',data.session.display_preview||'Conversation'),el('p',format(data.session.message_count)+' stored message rows · saved revisions retained.','muted'),actions,sessionMetadata(data.session));}
 $('reader').querySelector('[data-more-messages]')?.remove();
 for(const m of data.messages){const box=el('section',undefined,'message');box.id='message-'+m.id;const head=el('header');head.append(el('span',m.role==='assistant'?'Assistant':m.role==='user'?'You':m.role,'role'),el('p','#'+m.message_index+' · '+date(m.timestamp),'muted'));const text=el('pre',m.content);box.append(head,text);
  let meta={};try{meta=JSON.parse(m.metadata_json);}catch{}const info=el('details');info.append(el('summary','Source & capture details'),messageMetadata(meta));const raw=el('details');raw.append(el('summary','Raw metadata'),el('pre',JSON.stringify(meta,null,2)));info.append(raw);box.append(info);
  if(m.content_chars>8000){const more=el('button','More text ('+format(m.content_chars)+' characters total)','quiet');let offset=8000;more.addEventListener('click',async()=>{more.disabled=true;try{const r=await api('api/text?'+new URLSearchParams({id:m.id,offset:String(offset)}));text.textContent+=r.content;offset=r.next;if(offset===null)more.remove();}catch(e){error(e.message);}finally{more.disabled=false;}});box.append(more);}
  $('reader').append(box);
 }
 if(nextMessages!==null){const more=el('button','More messages','quiet');more.dataset.moreMessages='true';more.addEventListener('click',()=>openSession(ref,true));$('reader').append(more);}
 if(focusMessage){const target=$('message-'+focusMessage);if(target)target.scrollIntoView({block:'nearest'});else $('reader').prepend(el('p','This match is later in the session. Load more messages to reach it.','notice'));}
 }catch(e){error(e.message);}}
function changeView(next){view=next==='overview'?'overview':next==='projects'?'projects':($('query').value.trim()?'search':'browse');const active=view==='search'?'browse':view;for(const button of document.querySelectorAll('[data-view]')){if(button.dataset.view===active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');}$('overview').hidden=view!=='overview';$('projects-view').hidden=view!=='projects';$('library').hidden=view==='overview'||view==='projects';$('search-status').hidden=true;if(view==='browse'||view==='search')if(!overview?.billing||overview.billing.allowed)list(false);}
async function startStripeFlow(endpoint,btn){btn.disabled=true;error('');try{const res=await api(endpoint,{method:'POST',headers:{Origin:window.location.origin}});if(res.url)window.location.assign(res.url);}catch(e){error(e.message);btn.disabled=false;}}
$('mint-token').addEventListener('click',async()=>{const btn=$('mint-token');btn.disabled=true;error('');try{const res=await api('api/tokens',{method:'POST',headers:{Origin:window.location.origin}});$('token-value').textContent=res.token;$('token-box').hidden=false;$('token-note').hidden=false;}catch(e){error(e.message);}finally{btn.disabled=false;}});
$('copy-token').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('token-value').textContent||'');$('copy-token').textContent='Copied';setTimeout(()=>{$('copy-token').textContent='Copy';},1500);}catch{error('Copy failed; select the token manually.');}});
$('subscribe-btn').addEventListener('click',()=>startStripeFlow('api/billing/checkout',$('subscribe-btn')));
$('banner-subscribe').addEventListener('click',()=>startStripeFlow('api/billing/checkout',$('banner-subscribe')));
$('portal-btn').addEventListener('click',()=>startStripeFlow('api/billing/portal',$('portal-btn')));
$('delete-account-btn').addEventListener('click',async()=>{
 if(!window.confirm('Delete your xtctx account, revoke all tokens, erase all synced sessions on this server, and cancel any active subscription? Local files are untouched.'))return;
 if(!window.confirm('Final confirmation: permanently delete everything synced under this account?'))return;
 const btn=$('delete-account-btn');btn.disabled=true;error('');
 try{await api('api/account',{method:'DELETE',headers:{Origin:window.location.origin}});signedOut();}catch(e){error(e.message);}finally{btn.disabled=false;}
});
for(const button of document.querySelectorAll('[data-view]'))button.addEventListener('click',()=>changeView(button.dataset.view));
$('filters').addEventListener('submit',event=>{event.preventDefault();clearReader();view=$('query').value.trim()?'search':'browse';list(false);});
$('query').addEventListener('input',scopeLabel);
$('clear-filters').addEventListener('click',()=>{$('query').value='';$('project').value='';$('provider').value='';$('mode').value='hybrid';clearReader();changeView('browse');});
$('back-to-results').addEventListener('click',()=>{document.querySelector('.workspace').classList.remove('reader-open');$('sessions').querySelector('[aria-pressed="true"]')?.focus();});
$('more-sessions').addEventListener('click',()=>list(true));
$('refresh').addEventListener('click',()=>refresh().catch(e=>error(e.message)));
$('login-form').addEventListener('submit',async event=>{event.preventDefault();error('');const button=$('login-form').querySelector('button');button.disabled=true;try{const result=await api('login',{method:'POST'});const url=new URL(result.authorize_url);if(url.origin!=='https://github.com'||url.pathname!=='/login/oauth/authorize')throw Error('Unexpected sign-in destination.');window.location.assign(url.href);}catch(e){error(e.message);button.disabled=false;}});
$('logout').addEventListener('click',async()=>{try{await api('logout',{method:'POST'});signedOut();}catch(e){error(e.message);}});
refresh().catch(e=>{if($('app').hidden)error('');else error(e.message);});
