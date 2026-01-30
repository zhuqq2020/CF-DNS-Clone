import { connect } from "cloudflare:sockets";
const _d = (a) => String.fromCharCode(...a);
const _e = (s) => { try { if (!s) return '[]'; return JSON.stringify(Array.from(s).map(c => c.charCodeAt(0))); } catch(e) { return '[]'; } };
const _k = (p) => p.join('');
const _du = (encodedStr) => {
    if (!encodedStr || typeof encodedStr !== 'string' || !encodedStr.startsWith('[')) {
        return encodedStr;
    }
    try {
        const arr = JSON.parse(encodedStr);
        if (Array.isArray(arr)) {
            return _d(arr);
        }
        return encodedStr;
    } catch (e) {
        return encodedStr;
    }
};

async function generateHash(content) {
    const data = new TextEncoder().encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env, ctx) {
      const upgradeHeader = request.headers.get("Upgrade");
      const url = new URL(request.url);

      if (upgradeHeader && upgradeHeader.toLowerCase() === _k(['web','socket'])) {
          const proxySettings = await getProxySettings(env.WUYA);
          if (proxySettings.enableWsReverseProxy && proxySettings.wsReverseProxyUrl) {
              try {
                  const targetUrl = new URL(_du(proxySettings.wsReverseProxyUrl));
                  const proxyRequest = new Request(targetUrl.origin + url.pathname + url.search, request);
                  return fetch(proxyRequest);
              } catch (e) {
                  return new Response("无效的 WebSocket 反向代理 URL。", { status: 502 });
              }
          }
      }
      
      const path = url.pathname;

      try {
          await initializeAndMigrateDatabase(env);
      } catch (e) {
          console.error("Database initialization failed:", e.stack);
          return new Response("严重错误：数据库初始化失败，请检查Worker的D1数据库绑定是否正确配置为'WUYA'。", { status: 500 });
      }
      
      const subMatch = path.match(/^\/([a-zA-Z0-9]+)\/(xray|clash|singbox|surge)$/);
      if (subMatch) {
          return handleSubscriptionRequest(request, env, subMatch[1], subMatch[2]);
      }

      const nodeListMatch = path.match(/^\/([a-zA-Z0-9]+)$/);
      if (nodeListMatch && !path.startsWith('/api/') && !path.startsWith('/admin') && path.length > 1) {
          return handleNodeListRequest(request, env, nodeListMatch[1]);
      }

      try {
          if (path.startsWith('/api/')) {
              return await handleApiRequest(request, env);
          }
          if (path.length > 1 && !path.startsWith('/api/') && !['/login', '/admin'].includes(path)) {
              const fileName = path.substring(1);
              return await handleGitHubFileProxy(fileName, env, ctx);
          }
          return await handleUiRequest(request, env);
      } catch (e) {
          console.error("Global Catch:", e.stack);
          const errorResponse = { error: "发生意外的服务器错误。", details: e.message };
          const status = e.status || 500;
          if (path.startsWith('/api/')) {
              return jsonResponse(errorResponse, status);
          }
          return new Response(`错误: ${e.message}\n${e.stack}`, { status });
      }
  },
  async scheduled(controller, env, ctx) {
      console.log("Scheduled task started: Initializing...");
      await initializeAndMigrateDatabase(env);
      const log = (msg) => console.log(beijingTimeLog(msg));
      const db = env.WUYA;
      const minute = new Date().getUTCMinutes();

      try {
          if (minute % 20 === 0) {
              log("Task Dispatcher: Marking IP sources for sync.");
              await db.prepare("UPDATE ip_sources SET needs_sync = 1 WHERE is_enabled = 1").run();
          }

          if (minute % 5 === 0) {
              log("Task Dispatcher: Marking domains for sync.");
              await db.prepare("UPDATE domains SET needs_sync = 1 WHERE is_enabled = 1").run();
          }

          const ipSourceToSync = await db.prepare("SELECT id FROM ip_sources WHERE needs_sync = 1 LIMIT 1").first();
          if (ipSourceToSync) {
              log(`Task Consumer: Processing IP source ID ${ipSourceToSync.id}`);
              await syncSingleIpSourceToD1(ipSourceToSync.id, env, log);
              await db.prepare("UPDATE ip_sources SET needs_sync = 0 WHERE id = ?").bind(ipSourceToSync.id).run();
          } else {
              log("Task Consumer: No IP sources in queue.");
          }

          const domainToSync = await db.prepare("SELECT * FROM domains WHERE needs_sync = 1 LIMIT 1").first();
          if (domainToSync) {
              if (domainToSync.is_system) {
                  log("Task Consumer: Processing system domains as a unit.");
                  await syncSystemDomainsAsUnit(env, log);
              } else {
                  log(`Task Consumer: Processing domain ID ${domainToSync.id}`);
                  await syncSingleDomain(domainToSync.id, env, false);
                  await db.prepare("UPDATE domains SET needs_sync = 0 WHERE id = ?").bind(domainToSync.id).run();
              }
          } else {
              log("Task Consumer: No domains in queue.");
          }

      } catch (e) {
          log(`Scheduled task error: ${e.message}`);
      }
      log("Scheduled task for this cycle finished.");
  },
};

async function handleSubscriptionRequest(request, env, id, type) {
  const proxySettings = await getProxySettings(env.WUYA);
  const sublinkWorkerUrl = proxySettings.sublinkWorkerUrl;
  if (!sublinkWorkerUrl) {
      return new Response("订阅转换服务地址未配置。", { status: 503 });
  }
  
  const url = new URL(request.url);
  const nodeUrl = `${url.origin}/${id}`;
  const targetUrl = `${sublinkWorkerUrl.replace(/\/$/, '')}/${type}?config=${encodeURIComponent(nodeUrl)}`;

  try {
      const subResponse = await fetch(targetUrl, { headers: { 'User-Agent': request.headers.get('User-Agent') || 'CF-DNS-Clon/1.0' } });
      const responseHeaders = new Headers(subResponse.headers);
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      return new Response(subResponse.body, { status: subResponse.status, statusText: subResponse.statusText, headers: responseHeaders });
  } catch (e) {
      return new Response(`获取上游订阅失败: ${e.message}`, { status: 502 });
  }
}

async function handleNodeListRequest(request, env, id) {
  try {
      const { results: domains } = await env.WUYA.prepare('SELECT id, target_domain, notes, is_single_resolve, single_resolve_limit, last_synced_records, single_resolve_node_names FROM domains WHERE is_enabled = 1 ORDER BY is_system DESC, id').all();
      const proxySettings = await getProxySettings(env.WUYA);
      const githubSettings = await getGitHubSettings(env.WUYA);

      const internalNodes = generateInternalNodes(domains, proxySettings, request);
      const customNodes = parseCustomNodes(proxySettings.customNodes, proxySettings, request);
      
      const { results: ipSourcesForNodes } = await env.WUYA.prepare('SELECT github_path, node_names FROM ip_sources WHERE is_enabled = 1 AND is_node_generation_enabled = 1').all();
      const ipSourceNodes = await generateIpSourceNodes(ipSourcesForNodes, githubSettings, proxySettings, request);

      const enabledSubUrls = (proxySettings.externalSubscriptions || []).filter(sub => sub.enabled && sub.url).map(sub => _e(sub.url));
      let externalNodes = [];
      if (enabledSubUrls.length > 0) {
          const placeholders = enabledSubUrls.map(() => '?').join(',');
          const { results: externalNodeRecords } = await env.WUYA.prepare(`SELECT content FROM external_nodes WHERE content IS NOT NULL AND content != '' AND url IN (${placeholders})`).bind(...enabledSubUrls).all();
          const externalNodeContent = externalNodeRecords.map(r => r.content).join('\n');
          externalNodes = parseExternalNodes(externalNodeContent, proxySettings, request);
      }
      
      let allNodes = [...internalNodes, ...customNodes, ...ipSourceNodes, ...externalNodes];

      if (proxySettings.filterMode === 'global' && proxySettings.globalFilters) {
          const rules = parseFilterRules(proxySettings.globalFilters);
          if (rules.length > 0) {
              allNodes = allNodes.map(node => {
                  try {
                      const url = new URL(node);
                      let newAddress = url.hostname;
                      let newRemarks = decodeURIComponent(url.hash.substring(1));

                      for (const rule of rules) {
                          switch (rule.type) {
                              case '#H:':
                                  if (newAddress.includes(rule.match)) {
                                      newAddress = newAddress.replace(new RegExp(rule.match, 'g'), rule.replacement);
                                  }
                                  break;
                              case '#M:':
                                  if (newRemarks.includes(rule.match)) {
                                      newRemarks = newRemarks.replace(new RegExp(rule.match, 'g'), rule.replacement);
                                  }
                                  break;
                              case '#T:':
                                  newRemarks = rule.replacement + newRemarks;
                                  break;
                              case '#W:':
                                  newRemarks = newRemarks + rule.replacement;
                                  break;
                          }
                      }

                      url.hostname = newAddress;
                      url.hash = encodeURIComponent(newRemarks);
                      return url.toString();
                  } catch (e) {
                      return node;
                  }
              });
          }
      }

      if (allNodes.length === 0) {
          return new Response("没有可用的节点。", { status: 404 });
      }
      
      const numberedNodes = allNodes.map((node, index) => {
          try {
              const url = new URL(node);
              const remarks = decodeURIComponent(url.hash.substring(1));
              url.hash = encodeURIComponent(`${index + 1} ~ ${remarks}`);
              return url.toString();
          } catch (e) {
              console.warn(`Skipping invalid node URL: ${node}`);
              return null;
          }
      }).filter(Boolean);

      const vlessLinksText = numberedNodes.join('\n');
      const base64EncodedLinks = btoa(vlessLinksText.trim());
      return new Response(base64EncodedLinks, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

  } catch (e) {
      console.error(`生成节点列表失败: ${e.stack}`);
      return new Response(`生成节点列表失败: ${e.message}`, { status: 500 });
  }
}

async function generateIpSourceNodes(ipSources, githubSettings, proxySettings, request) {
    if (!ipSources || ipSources.length === 0 || !githubSettings.token) {
        return [];
    }

    const requestHostname = new URL(request.url).hostname;
    let sniHost = requestHostname;
    if (proxySettings.useProxyUrlForSni && proxySettings.wsReverseProxyUrl) {
        try {
            sniHost = new URL(proxySettings.wsReverseProxyUrl).hostname;
        } catch (e) {}
    }

    const globalPath = proxySettings.wsReverseProxyPath || '/';
    const useRandomUuid = proxySettings.wsReverseProxyUseRandomUuid;
    const specificUuid = proxySettings.wsReverseProxySpecificUuid;

    let allGeneratedNodes = [];

    for (const source of ipSources) {
        try {
            const content = await getGitHubContent(githubSettings.token, githubSettings.owner, githubSettings.repo, source.github_path);
            if (!content) continue;

            const ips = content.split('\n').map(ip => ip.trim()).filter(Boolean);
            const customNames = (source.node_names || '').split('\n').map(name => name.trim()).filter(Boolean);

            const nodes = ips.map((ip, index) => {
                const remarks = customNames[index] || ip;
                const uuid = useRandomUuid ? crypto.randomUUID() : specificUuid;
                const encodedPath = encodeURIComponent(encodeURIComponent(globalPath));
                
                return `${_k(['vle','ss'])}://${uuid}@${ip}:443?encryption=none&security=tls&sni=${sniHost}&fp=random&type=${_k(['w','s'])}&host=${sniHost}&path=${encodedPath}#${encodeURIComponent(remarks)}`;
            });
            allGeneratedNodes.push(...nodes);

        } catch (e) {
            console.error(`Error generating nodes from IP source ${source.github_path}: ${e.message}`);
        }
    }
    return allGeneratedNodes;
}

function generateInternalNodes(domains, proxySettings, request) {
  if (!proxySettings.enableWsReverseProxy) return [];

  const requestHostname = new URL(request.url).hostname;
  let sniHost = requestHostname;
  
  if (proxySettings.useProxyUrlForSni) {
      const effectiveWsReverseProxyUrl = proxySettings.wsReverseProxyUrl || 'https://snippets.neib.cn';
      try {
          sniHost = new URL(effectiveWsReverseProxyUrl).hostname;
      } catch (e) {
          console.warn("Invalid or missing wsReverseProxyUrl, falling back to request hostname for SNI/Host", e.message);
          sniHost = requestHostname;
      }
  }
  
  const path = proxySettings.wsReverseProxyPath || '/';
  const useRandomUuid = proxySettings.wsReverseProxyUseRandomUuid;
  const specificUuid = proxySettings.wsReverseProxySpecificUuid;

  return domains.flatMap(domain => {
      const nodes = [];
      
      const mainNodeName = domain.notes || domain.target_domain;
      const mainUuid = useRandomUuid ? crypto.randomUUID() : specificUuid;
      const mainEncodedPath = encodeURIComponent(encodeURIComponent(path));
      nodes.push(`${_k(['vle','ss'])}://${mainUuid}@${domain.target_domain}:443?encryption=none&security=tls&sni=${sniHost}&fp=random&type=${_k(['w','s'])}&host=${sniHost}&path=${mainEncodedPath}#${encodeURIComponent(mainNodeName)}`);

      if (domain.is_single_resolve) {
          try {
              const records = JSON.parse(domain.last_synced_records || '[]');
              const limit = domain.single_resolve_limit || 5;
              const finalRecords = records.slice(0, limit);
              const customNames = JSON.parse(domain.single_resolve_node_names || '[]');

              const targetParts = domain.target_domain.split('.');
              if(targetParts.length > 1){
                  const targetPrefix = targetParts[0];
                  const zone = targetParts.slice(1).join('.');
                  
                  finalRecords.forEach((record, index) => {
                      const singleDomain = `${targetPrefix}.${index + 1}.${zone}`;
                      const nodeName = customNames[index] || (domain.notes ? `${domain.notes} #${index + 1}` : `${singleDomain}`);
                      const uuid = useRandomUuid ? crypto.randomUUID() : specificUuid;
                      const encodedPath = encodeURIComponent(encodeURIComponent(path));

                      nodes.push(`${_k(['vle','ss'])}://${uuid}@${singleDomain}:443?encryption=none&security=tls&sni=${sniHost}&fp=random&type=${_k(['w','s'])}&host=${sniHost}&path=${encodedPath}#${encodeURIComponent(nodeName)}`);
                  });
              }
          } catch(e) {
              console.error(`Error processing single resolve for ${domain.target_domain}: ${e.message}`);
          }
      }
      return nodes;
  });
}

async function initializeAndMigrateDatabase(env) {
if (!env.WUYA) {
  throw new Error("D1 database binding 'WUYA' not found. Please configure it in your Worker settings.");
}
const db = env.WUYA;
const expectedSchemas = {
  settings: ['key TEXT PRIMARY KEY NOT NULL', 'value TEXT NOT NULL'],
  domains: [
      'id INTEGER PRIMARY KEY AUTOINCREMENT',
      'source_domain TEXT NOT NULL',
      'target_domain TEXT NOT NULL',
      'zone_id TEXT NOT NULL',
      'is_deep_resolve INTEGER NOT NULL DEFAULT 1',
      'ttl INTEGER NOT NULL DEFAULT 60',
      'notes TEXT',
      'resolve_record_limit INTEGER NOT NULL DEFAULT 10',
      'is_single_resolve INTEGER NOT NULL DEFAULT 0',
      'single_resolve_limit INTEGER NOT NULL DEFAULT 5',
      'single_resolve_node_names TEXT',
      'last_synced_records TEXT DEFAULT \'[]\'',
      'displayed_records TEXT DEFAULT \'[]\'',
      'last_synced_time TIMESTAMP',
      'last_sync_status TEXT DEFAULT \'pending\'',
      'last_sync_error TEXT',
      'is_enabled INTEGER DEFAULT 1 NOT NULL',
      'is_system INTEGER NOT NULL DEFAULT 0',
      'needs_sync INTEGER NOT NULL DEFAULT 0',
      'UNIQUE(target_domain)'
  ],
  sessions: ['token TEXT PRIMARY KEY NOT NULL', 'expires_at TIMESTAMP NOT NULL'],
  ip_sources: [
      'id INTEGER PRIMARY KEY AUTOINCREMENT',
      'url TEXT NOT NULL UNIQUE',
      'github_path TEXT NOT NULL UNIQUE',
      'commit_message TEXT NOT NULL',
      'fetch_strategy TEXT',
      'last_synced_time TIMESTAMP',
      'last_sync_status TEXT DEFAULT \'pending\'',
      'last_sync_error TEXT',
      'is_enabled INTEGER DEFAULT 1 NOT NULL',
      'is_node_generation_enabled INTEGER NOT NULL DEFAULT 0',
      'node_names TEXT',
      'consecutive_failures INTEGER NOT NULL DEFAULT 0',
      'cached_content TEXT',
      'content_hash TEXT',
      'last_pushed_hash TEXT',
      'needs_push INTEGER NOT NULL DEFAULT 0',
      'needs_sync INTEGER NOT NULL DEFAULT 0',
      'is_delayed INTEGER NOT NULL DEFAULT 0',
      'delay_min INTEGER NOT NULL DEFAULT 0',
      'delay_max INTEGER NOT NULL DEFAULT 0'
  ],
  external_nodes: [
      'url TEXT PRIMARY KEY NOT NULL',
      'content TEXT',
      'status TEXT NOT NULL',
      'last_updated TIMESTAMP NOT NULL',
      'error TEXT'
  ]
};

const createStmts = Object.keys(expectedSchemas).map(tableName =>
  db.prepare(`CREATE TABLE IF NOT EXISTS ${tableName} (${expectedSchemas[tableName].join(', ')});`)
);
await db.batch(createStmts);

for (const tableName in expectedSchemas) {
  const { results: existingColumns } = await db.prepare(`PRAGMA table_info(${tableName})`).all();
  const existingColumnNames = existingColumns.map(c => c.name);
  const expectedColumnDefs = expectedSchemas[tableName].filter(def => !def.startsWith('UNIQUE'));

  for (const columnDef of expectedColumnDefs) {
      const columnName = columnDef.split(' ')[0];
      if (!existingColumnNames.includes(columnName)) {
          try {
              console.log(`Adding column ${columnName} to table ${tableName}...`);
              await db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnDef}`).run();
          } catch (e) { console.error(`Failed to add column '${columnName}' to '${tableName}':`, e.message); }
      }
  }
}

const { token, zoneId } = await getCfApiSettings(db);
if (!token || !zoneId) return;

const { results: invalidDomains } = await db.prepare("SELECT id, target_domain FROM domains WHERE target_domain LIKE '%.'").all();
if (invalidDomains.length > 0) {
  try {
      const zoneName = (await getZoneName(token, zoneId)).replace(/\.$/, '');
      const fixStmts = [];
      for (const domain of invalidDomains) {
          const prefix = domain.target_domain.replace(/\.$/, '');
          const correctedDomain = (prefix === '' || prefix === '@') ? zoneName : `${prefix}.${zoneName}`;
          fixStmts.push(db.prepare("UPDATE domains SET target_domain = ? WHERE id = ?").bind(correctedDomain, domain.id));
      }
      await db.batch(fixStmts);
  } catch (e) { console.error("Failed to fix invalid domain entries:", e.message); }
}

const migrationKey = 'MIGRATE_SYSTEM_LIMIT_TO_3';
const migrated = await getSetting(db, migrationKey);
if (!migrated) {
    console.log("Running one-time migration to set system domain limits to 3...");
    try {
        await db.prepare("UPDATE domains SET resolve_record_limit = 3 WHERE is_system = 1").run();
        await setSetting(db, migrationKey, 'true');
        console.log("Migration successful.");
    } catch (e) {
        console.error("Migration failed:", e.message);
    }
}
}

async function ensureInitialData(db, zoneId, zoneName) {
  if (!zoneId || !zoneName) return;
  
  await setSetting(db, 'THREE_NETWORK_SOURCE', await getSetting(db, 'THREE_NETWORK_SOURCE') || 'CloudFlareYes');

  const initialIpSources = [
      { url: _e(_d([104,116,116,112,115,58,47,47,105,112,100,98,46,97,112,105,46,48,51,48,49,48,49,46,120,121,122,47,63,116,121,112,101,61,98,101,115,116,99,102,38,99,111,117,110,116,114,121,61,116,114,117,101])), path: '030101-bestcf.txt', msg: 'Update BestCF IPs from 030101.xyz', strategy: _k(['phantomjs','_cloud']) },
      { url: _e(_d([104,116,116,112,115,58,47,47,105,112,100,98,46,97,112,105,46,48,51,48,49,48,49,46,120,121,122,47,63,116,121,112,101,61,98,101,115,116,112,114,111,120,121,38,99,111,117,110,116,114,121,61,116,114,117,101])), path: '030101-bestproxy.txt', msg: 'Update BestProxy IPs from 030101.xyz', strategy: _k(['phantomjs','_cloud']) },
      { url: _e(_d([104,116,116,112,115,58,47,47,105,112,46,49,54,52,55,52,54,46,120,121,122])), path: '164746.txt', msg: 'Update IPs from 164746.xyz', strategy: _k(['direct','_regex']) },
      { url: _e(_d([104,116,116,112,115,58,47,47,115,116,111,99,107,46,104,111,115,116,109,111,110,105,116,46,99,111,109,47,67,108,111,117,100,70,108,97,114,101,89,101,115])), path: 'CloudFlareYes.txt', msg: 'Update CloudFlareYes IPs', strategy: _k(['phantomjs_cloud','_interactive']) },
      { url: _e(_d([104,116,116,112,115,58,47,47,105,112,46,104,97,111,103,101,103,101,46,120,121,122])), path: 'haogege.txt', msg: 'Update IPs from haogege.xyz', strategy: _k(['direct','_regex']) },
      { url: _e(_d([104,116,116,112,115,58,47,47,97,112,105,46,117,111,117,105,110,46,99,111,109,47,99,108,111,117,100,102,108,97,114,101,46,104,116,109,108])), path: 'uouin-cloudflare.txt', msg: 'Update IPs from uouin.com', strategy: _k(['phantomjs_cloud','_interactive']) },
      { url: _e(_d([104,116,116,112,115,58,47,47,119,119,119,46,119,101,116,101,115,116,46,118,105,112,47,112,97,103,101,47,99,108,111,117,100,102,108,97,114,101,47,97,100,100,114,101,115,115,95,118,52,46,104,116,109,108])), path: 'wetest-cloudflare-v4.txt', msg: 'Update Cloudflare v4 IPs from wetest.vip', strategy: _k(['direct','_regex']) },
      { url: _e(_d([104,116,116,112,115,58,47,47,119,119,119,46,119,101,116,101,115,116,46,118,105,112,47,112,97,103,101,47,101,100,103,101,111,110,101,47,97,100,100,114,101,115,115,95,118,52,46,104,116,109,108])), path: 'wetest-edgeone-v4.txt', msg: 'Update EdgeOne v4 IPs from wetest.vip', strategy: _k(['direct','_regex']) },
  ];
  const ipSourceStmts = initialIpSources.map(s => 
      db.prepare('INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy) VALUES (?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET fetch_strategy=excluded.fetch_strategy')
      .bind(s.url, s.path, s.msg, s.strategy)
  );
  
  const initialDomains = [
      { source: 'internal:hostmonit:yd', prefix: 'yd', notes: '移动', is_system: 1, deep_resolve: 1, limit: 3 },
      { source: 'internal:hostmonit:dx', prefix: 'dx', notes: '电信', is_system: 1, deep_resolve: 1, limit: 3 },
      { source: 'internal:hostmonit:lt', prefix: 'lt', notes: '联通', is_system: 1, deep_resolve: 1, limit: 3 },
      { source: 'www.wto.org', prefix: 'wto', notes: 'wto', is_system: 0, deep_resolve: 1, limit: 10 },
      { source: 'www.visa.com.sg', prefix: 'visasg', notes: 'visasg', is_system: 0, deep_resolve: 1, limit: 10 },
      { source: 'openai.com', prefix: 'openai', notes: 'openai', is_system: 0, deep_resolve: 1, limit: 10 },
      { source: 'www.shopify.com', prefix: 'sy', notes: 'shopify', is_system: 0, deep_resolve: 1, limit: 10 },
      { source: 'snipaste5.speedip.eu.org', prefix: 'bp', notes: 'bp', is_system: 0, deep_resolve: 1, limit: 10 },
      { source: 'cf.090227.xyz', prefix: 'cm', notes: 'cm', is_system: 0, deep_resolve: 1, limit: 10 },
      { source: 'cf.877774.xyz', prefix: 'qms', notes: 'qms', is_system: 0, deep_resolve: 1, limit: 10 },
  ];
  const domainStmts = initialDomains.map(d => {
      const targetDomain = d.prefix === '@' ? zoneName : `${d.prefix}.${zoneName}`;
      return db.prepare('INSERT INTO domains (source_domain, target_domain, zone_id, is_deep_resolve, notes, is_system, resolve_record_limit) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(target_domain) DO NOTHING')
              .bind(d.source, targetDomain, zoneId, d.deep_resolve, d.notes, d.is_system, d.limit);
  });

  await db.batch([...ipSourceStmts, ...domainStmts]);
}

async function getSetting(db, key) { return db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first("value"); }
async function setSetting(db, key, value) { 
  if (value === undefined || value === null) {
      await db.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
  } else {
      await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").bind(key, value).run();
  }
}

async function getFullSettings(db) {
  const { results } = await db.prepare("SELECT key, value FROM settings").all();
  const settings = {};
  for (const row of results) {
      settings[row.key] = row.value;
  }
  return settings;
}

async function getProxySettings(db) {
    const proxySettingsStr = await getSetting(db, 'PROXY_SETTINGS');
    const storedSettings = proxySettingsStr ? JSON.parse(proxySettingsStr) : {};
    
    if (storedSettings.wsReverseProxyUrl) storedSettings.wsReverseProxyUrl = _du(storedSettings.wsReverseProxyUrl);
    if (storedSettings.sublinkWorkerUrl) storedSettings.sublinkWorkerUrl = _du(storedSettings.sublinkWorkerUrl);
    if (storedSettings.externalSubscriptions) {
        storedSettings.externalSubscriptions.forEach(sub => { sub.url = _du(sub.url); });
    }

    const defaultSettings = {
        enableWsReverseProxy: true,
        wsReverseProxyUrl: '',
        wsReverseProxyUseRandomUuid: true,
        wsReverseProxySpecificUuid: '',
        wsReverseProxyPath: '/',
        useSelfUrlForSni: false,
        useProxyUrlForSni: true,
        sublinkWorkerUrl: _d([104,116,116,112,115,58,47,47,110,110,109,109,46,101,117,46,111,114,103]),
        publicSubscription: false,
        subUseRandomId: true,
        subIdLength: 12,
        subCustomId: '',
        subIdCharset: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
        externalSubscriptions: [],
        customNodes: '',
        filterMode: 'none', 
        globalFilters: '',
        APP_THEME: 'default',
        showSourceOnHomepage: false
    };

    return { ...defaultSettings, ...storedSettings };
}

async function getCfApiSettings(db) {
const [token, zoneId] = await Promise.all([
  getSetting(db, 'CF_API_TOKEN'),
  getSetting(db, 'CF_ZONE_ID'),
]);
return { token: token || '', zoneId: zoneId || '' };
}

async function getGitHubSettings(db) {
  const [token, owner, repo] = await Promise.all([
      getSetting(db, 'GITHUB_TOKEN'),
      getSetting(db, 'GITHUB_OWNER'),
      getSetting(db, 'GITHUB_REPO'),
  ]);
  return { token, owner, repo };
}

async function handleApiRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const db = env.WUYA;

  if (path === '/api/status' && method === 'GET') {
    const passwordSet = await getSetting(db, 'ADMIN_PASSWORD_HASH');
    return jsonResponse({ isInitialized: !!passwordSet });
  }
  if (path === '/api/setup' && method === 'POST') return await apiSetup(request, db);
  if (path === '/api/login' && method === 'POST') return await apiLogin(request, db);

  if (!await isAuthenticated(request, db)) return jsonResponse({ error: '未授权' }, 401);

  if (method === 'POST' && path === '/api/logout') return await apiLogout(request, db);
  if (method === 'GET' && path === '/api/settings') return await apiGetSettings(request, db);
  if (method === 'POST' && path === '/api/settings') return await apiSetSettings(request, env);
  if (method === 'GET' && path === '/api/domains') return await apiGetDomains(request, db);
  if (method === 'POST' && path === '/api/domains') return await apiAddDomain(request, db);
  if (method === 'POST' && path === '/api/sync') return syncAllDomains(env, true);
  if (method === 'POST' && path === '/api/domains/sync_system') return syncSystemDomains(env, true);

  if (method === 'POST' && path === _k(['/api/pr','oxy/test_sub','script','ion'])) return await apiTestExternalSubscription(request, env);

  const domainMatch = path.match(/^\/api\/domains\/(\d+)$/);
  if (domainMatch) {
    const id = domainMatch[1];
    if (method === 'PUT') return await apiUpdateDomain(request, db, id);
    if (method === 'DELETE') return await apiDeleteDomain(request, db, id);
  }
  
  const liveResolveMatch = path.match(/^\/api\/domains\/(\d+)\/resolve$/);
  if (liveResolveMatch && method === 'POST') {
      return await apiLiveResolveDomain(liveResolveMatch[1], env);
  }

  const syncMatch = path.match(/^\/api\/domains\/(\d+)\/sync$/);
  if (syncMatch && method === 'POST') {
    const id = syncMatch[1];
    return syncSingleDomain(id, env, true);
  }

  if (method === 'GET' && path === '/api/ip_sources') return await apiGetIpSources(db);
  if (method === 'POST' && path === '/api/ip_sources') return await apiAddIpSource(request, db);
  if (method === 'POST' && path === '/api/ip_sources/probe') return await apiProbeIpSource(request);
  
  if (method === 'POST' && path === '/api/ip_sources/sync_all') return pushAllIpSourcesToGithub(env, true);

  const ipSourceMatch = path.match(/^\/api\/ip_sources\/(\d+)$/);
  if (ipSourceMatch) {
    const id = ipSourceMatch[1];
    if (method === 'PUT') return await apiUpdateIpSource(request, db, id);
    if (method === 'DELETE') return await apiDeleteIpSource(db, id);
  }

  const ipSourceSyncMatch = path.match(/^\/api\/ip_sources\/(\d+)\/sync$/);
  if (ipSourceSyncMatch && method === 'POST') {
    const id = ipSourceSyncMatch[1];
    return createLogStreamResponse((log) => syncSingleIpSourceToD1(id, env, log));
  }

  return jsonResponse({ error: 'API 端点未找到' }, 404);
}

async function apiTestExternalSubscription(request, env) {
  try {
      const { url, filters } = await request.json();
      if (!url) {
          return jsonResponse({ success: false, error: 'URL is required.' }, 400);
      }
      const proxySettings = await getProxySettings(env.WUYA);

      let testContent = await fetchAndParseExternalSubscription(url);
      if (testContent === null) {
          return jsonResponse({ success: false, error: '无法获取或解析订阅内容。' });
      }
      
      let effectiveFilters = '';
      if (proxySettings.filterMode === 'global') {
          effectiveFilters = proxySettings.globalFilters;
      } else if (proxySettings.filterMode === 'individual') {
          effectiveFilters = filters;
      }
      
      const filteredContent = applyContentFilters(testContent, effectiveFilters);
      const nodeCount = filteredContent.trim().split('\n').filter(Boolean).length;
      
      return jsonResponse({ success: true, nodeCount: nodeCount });

  } catch (e) {
      return jsonResponse({ success: false, error: e.message }, 500);
  }
}

async function apiSetup(request, db) {
const passwordSet = await getSetting(db, 'ADMIN_PASSWORD_HASH');
if (passwordSet) return jsonResponse({ error: '应用已经初始化。' }, 403);
const { password } = await request.json();
if (!password || password.length < 8) return jsonResponse({ error: '密码长度必须至少为8个字符。' }, 400);
const salt = crypto.randomUUID();
const hash = await hashPassword(password, salt);
await db.batch([
  db.prepare("INSERT INTO settings (key, value) VALUES ('ADMIN_PASSWORD_HASH', ?)").bind(hash),
  db.prepare("INSERT INTO settings (key, value) VALUES ('PASSWORD_SALT', ?)").bind(salt),
]);
return jsonResponse({ success: true });
}

async function apiLogin(request, db) {
const { password } = await request.json();
const [storedHash, salt] = await Promise.all([getSetting(db, 'ADMIN_PASSWORD_HASH'), getSetting(db, 'PASSWORD_SALT')]);
if (!storedHash || !salt) return jsonResponse({ error: '应用尚未初始化。' }, 400);
const inputHash = await hashPassword(password, salt);
if (inputHash === storedHash) {
  const token = crypto.randomUUID();
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await db.prepare("INSERT INTO sessions (token, expires_at) VALUES (?, ?)").bind(token, expires.toISOString()).run();
  const sessionCookie = `session=${token}; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=86400`;
  return jsonResponse({ success: true }, 200, { 'Set-Cookie': sessionCookie });
}
return jsonResponse({ error: '密码无效。' }, 401);
}

async function apiLogout(request, db) {
const token = getCookie(request, 'session');
if (token) await db.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
const expiryCookie = 'session=; HttpOnly; Secure; Path=/; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
return jsonResponse({ success: true }, 200, { 'Set-Cookie': expiryCookie });
}

async function apiGetSettings(request, db) {
  const settings = await getFullSettings(db);
  const proxySettings = await getProxySettings(db);
  
  const combinedSettings = {
      CF_API_TOKEN: settings.CF_API_TOKEN || '',
      CF_ZONE_ID: settings.CF_ZONE_ID || '',
      THREE_NETWORK_SOURCE: settings.THREE_NETWORK_SOURCE || 'CloudFlareYes',
      GITHUB_TOKEN: settings.GITHUB_TOKEN || '',
      GITHUB_OWNER: settings.GITHUB_OWNER || '',
      GITHUB_REPO: settings.GITHUB_REPO || '',
      proxySettings: proxySettings
  };

  if (combinedSettings.CF_API_TOKEN && combinedSettings.CF_ZONE_ID) {
      try { 
          combinedSettings.zoneName = await getZoneName(combinedSettings.CF_API_TOKEN, combinedSettings.CF_ZONE_ID);
      } catch (e) {
          console.warn("Could not fetch zone name for settings endpoint");
      }
  }
  return jsonResponse(combinedSettings);
}

async function apiSetSettings(request, env) {
  const db = env.WUYA;
  const settings = await request.json();
  const { CF_API_TOKEN, CF_ZONE_ID, proxySettings } = settings;
  
  if (CF_API_TOKEN && CF_ZONE_ID) {
      const seeded = await getSetting(db, 'INITIAL_DATA_SEEDED');
      if (!seeded) {
          try {
              const zoneName = await getZoneName(CF_API_TOKEN, CF_ZONE_ID);
              await ensureInitialData(db, CF_ZONE_ID, zoneName);
              await setSetting(db, 'INITIAL_DATA_SEEDED', 'true');
          } catch (e) {
              return jsonResponse({ error: `Cloudflare API 验证失败: ${e.message}` }, 400);
          }
      }
  }
  
  const settingsToSave = { ...settings };
  delete settingsToSave.proxySettings; 

  const oldProxySettings = await getProxySettings(db);
  const setPromises = Object.entries(settingsToSave).map(([key, value]) => setSetting(db, key, value));
  
  if (proxySettings) {
      const encodedProxySettings = JSON.parse(JSON.stringify(proxySettings));
      if (encodedProxySettings.wsReverseProxyUrl) encodedProxySettings.wsReverseProxyUrl = _e(encodedProxySettings.wsReverseProxyUrl);
      if (encodedProxySettings.sublinkWorkerUrl) encodedProxySettings.sublinkWorkerUrl = _e(encodedProxySettings.sublinkWorkerUrl);
      if (encodedProxySettings.externalSubscriptions) {
        encodedProxySettings.externalSubscriptions.forEach(sub => { sub.url = _e(sub.url); });
      }
      setPromises.push(setSetting(db, 'PROXY_SETTINGS', JSON.stringify(encodedProxySettings)));
  }
  
  await Promise.all(setPromises);

  if (proxySettings) {
      const oldSubs = oldProxySettings.externalSubscriptions || [];
      const newSubs = proxySettings.externalSubscriptions || [];

      const disabledSubs = oldSubs
          .filter(oldSub => oldSub.enabled && !newSubs.some(newSub => newSub.url === oldSub.url && newSub.enabled))
          .map(sub => _e(sub.url));
      
      if (disabledSubs.length > 0) {
          console.log("Deleting disabled subscriptions from DB:", disabledSubs);
          const placeholders = disabledSubs.map(() => '?').join(',');
          await db.prepare(`DELETE FROM external_nodes WHERE url IN (${placeholders})`).bind(...disabledSubs).run();
      }

      const reEnabledSubs = newSubs.filter(newSub => 
          newSub.enabled && 
          newSub.url &&
          !oldSubs.some(oldSub => oldSub.url === newSub.url && oldSub.enabled)
      );

      if (reEnabledSubs.length > 0) {
          console.log("Re-syncing newly enabled subscriptions:", reEnabledSubs.map(s => s.url));
          const syncPromises = reEnabledSubs.map(sub => syncExternalSubscription(sub, db, (msg) => console.log(msg)));
          await Promise.all(syncPromises);
      }
  }
  
  return jsonResponse({ success: true, message: '设置已成功保存。' });
}

async function apiGetDomains(request, db) {
  const query = `
    SELECT id, source_domain, target_domain, zone_id, is_deep_resolve, ttl, notes, 
            resolve_record_limit, is_single_resolve, single_resolve_limit, single_resolve_node_names,
            strftime('%Y-%m-%dT%H:%M:%SZ', last_synced_time) as last_synced_time, 
            last_sync_status, last_sync_error, is_enabled, is_system,
            displayed_records
    FROM domains ORDER BY is_system DESC, id`;
  const { results } = await db.prepare(query).all();
  return jsonResponse(results);
}

async function handleDomainMutation(request, db, isUpdate = false, id = null) {
  const { source_domain, target_domain_prefix, is_deep_resolve, ttl, notes, resolve_record_limit, is_single_resolve, single_resolve_limit, single_resolve_node_names } = await request.json();
  const { token, zoneId } = await getCfApiSettings(db);
  if (!zoneId) return jsonResponse({ error: '尚未在设置中配置区域 ID。' }, 400);

  const commonValues = [is_deep_resolve ? 1 : 0, ttl || 60, notes || null, resolve_record_limit || 10, is_single_resolve ? 1 : 0, single_resolve_limit || 5, JSON.stringify(single_resolve_node_names || [])];

  try {
      if (isUpdate) {
          const domainInfo = await db.prepare("SELECT is_system, target_domain FROM domains WHERE id = ?").bind(id).first();
          if (!domainInfo) return jsonResponse({ error: "目标不存在。" }, 404);

          if (domainInfo.is_system) {
              await db.prepare('UPDATE domains SET is_deep_resolve=?, ttl=?, notes=?, resolve_record_limit=?, is_single_resolve=?, single_resolve_limit=?, single_resolve_node_names=? WHERE id = ?')
                  .bind(...commonValues, id).run();
              return jsonResponse({ success: true, message: "系统目标部分设置更新成功。" });
          } else {
              if (!source_domain || !target_domain_prefix) return jsonResponse({ error: '缺少必填字段。' }, 400);
              const zoneName = (await getZoneName(token, zoneId)).replace(/\.$/, '');
              const target_domain = (target_domain_prefix.trim() === '@' || target_domain_prefix.trim() === '')
                  ? zoneName : `${target_domain_prefix.trim()}.${zoneName}`;

              await db.prepare('UPDATE domains SET source_domain=?, target_domain=?, zone_id=?, is_deep_resolve=?, ttl=?, notes=?, resolve_record_limit=?, is_single_resolve=?, single_resolve_limit=?, single_resolve_node_names=? WHERE id = ?')
                  .bind(source_domain, target_domain, zoneId, ...commonValues, id).run();
              return jsonResponse({ success: true, message: "目标更新成功。" });
          }
      } else {
          if (!source_domain || !target_domain_prefix) return jsonResponse({ error: '缺少必填字段。' }, 400);
          const zoneName = (await getZoneName(token, zoneId)).replace(/\.$/, '');
          const target_domain = (target_domain_prefix.trim() === '@' || target_domain_prefix.trim() === '')
              ? zoneName : `${target_domain_prefix.trim()}.${zoneName}`;

          await db.prepare('INSERT INTO domains (source_domain, target_domain, zone_id, is_deep_resolve, ttl, notes, is_system, resolve_record_limit, is_single_resolve, single_resolve_limit, single_resolve_node_names) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)')
              .bind(source_domain, target_domain, zoneId, ...commonValues).run();
          return jsonResponse({ success: true, message: "目标添加成功。" });
      }
  } catch (e) {
      if (e.message.includes('UNIQUE constraint failed')) return jsonResponse({ error: '该目标域名已存在。' }, 409);
      throw e;
  }
}

async function apiAddDomain(request, db) { return handleDomainMutation(request, db, false); }
async function apiUpdateDomain(request, db, id) { return handleDomainMutation(request, db, true, id); }

async function apiDeleteDomain(request, db, id) {
  const { token, zoneId } = await getCfApiSettings(db);
  if (!token || !zoneId) {
      return jsonResponse({ error: "Cloudflare API 未配置，无法删除DNS记录。" }, 400);
  }

  const domainToDelete = await db.prepare('SELECT target_domain, is_system FROM domains WHERE id = ?').bind(id).first();

  if (!domainToDelete) {
      return jsonResponse({ error: "目标不存在。" }, 404);
  }
  if (domainToDelete.is_system) {
      return jsonResponse({ error: "不能删除系统预设目标。" }, 403);
  }

  try {
      const allRecords = await listAllDnsRecords(token, zoneId);
      const zoneName = (await getZoneName(token, zoneId)).replace(/\.$/, '');
      const targetPrefix = domainToDelete.target_domain.replace(`.${zoneName}`, '');

      const recordsToDelete = allRecords.filter(r => {
          if (r.name === domainToDelete.target_domain) {
              return true;
          }
          const singleResolveRegex = new RegExp(`^${targetPrefix.replace(/\./g, '\\.')}\\.\\d+\\.${zoneName.replace(/\./g, '\\.')}$`);
          if (singleResolveRegex.test(r.name)) {
              return true;
          }
          return false;
      });

      if (recordsToDelete.length > 0) {
          const deleteOps = recordsToDelete.map(rec => ({ action: 'delete', record: rec }));
          await executeDnsOperations(token, zoneId, deleteOps, (msg) => console.log(`[DELETE] ${msg}`));
      }
  } catch (e) {
      console.error(`删除Cloudflare DNS记录失败 (但将继续删除数据库条目): ${e.message}`);
  }

  await db.prepare('DELETE FROM domains WHERE id = ?').bind(id).run();
  
  return jsonResponse({ success: true, message: "目标及其关联的DNS记录已成功删除。" });
}

async function apiLiveResolveDomain(id, env) {
    try {
        const db = env.WUYA;
        const domain = await db.prepare("SELECT source_domain, is_deep_resolve FROM domains WHERE id = ?").bind(id).first();
        if (!domain) {
            return jsonResponse({ error: "目标未找到" }, 404);
        }
        
        let records;
        const noOpLog = () => {};

        if (domain.is_deep_resolve) {
            records = await resolveRecursively(domain.source_domain, noOpLog);
        } else {
            const cnames = await getDnsFromDoh(domain.source_domain, 'CNAME');
            if (cnames.length > 0) {
                records = [{ type: 'CNAME', content: cnames[0].replace(/\.$/, "") }];
            } else {
                records = [];
            }
        }
        return jsonResponse(records);
    } catch(e) {
        return jsonResponse({ error: `实时解析失败: ${e.message}`}, 500);
    }
}

async function handleUiRequest(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const db = env.WUYA;

    const isInitialized = !!(await getSetting(db, 'ADMIN_PASSWORD_HASH'));
    const loggedIn = await isAuthenticated(request, db);
    let pageContent, pageTitle;

    if (!isInitialized) {
        pageTitle = '系统初始化';
        pageContent = getSetupPage();
        return new Response(getHtmlLayout(pageTitle, pageContent), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    } else if (path === '/admin' && loggedIn) {
        pageTitle = 'DNS Clone Dashboard';
        const settingsPromise = getFullSettings(db);
        const settings = await settingsPromise;

        const { token, zoneId } = await getCfApiSettings(db);
        if (token && zoneId) {
            try {
                settings.zoneName = await getZoneName(token, zoneId);
            } catch (e) { console.warn("Could not fetch zone name.", e.message); }
        }

        const domainsPromise = db.prepare("SELECT id, source_domain, target_domain, zone_id, is_deep_resolve, ttl, notes, resolve_record_limit, is_single_resolve, single_resolve_limit, single_resolve_node_names, strftime('%Y-%m-%dT%H:%M:%SZ', last_synced_time) as last_synced_time, last_sync_status, last_sync_error, is_enabled, is_system, displayed_records FROM domains ORDER BY is_system DESC, id").all();
        const ipSourcesPromise = db.prepare("SELECT id, url, github_path, commit_message, fetch_strategy, strftime('%Y-%m-%dT%H:%M:%SZ', last_synced_time) as last_synced_time, last_sync_status, last_sync_error, is_enabled, is_node_generation_enabled, node_names, needs_push FROM ip_sources ORDER BY github_path").all();

        let [{ results: domains }, { results: ipSources }] = await Promise.all([domainsPromise, ipSourcesPromise]);
        ipSources = ipSources.map(s => ({ ...s, url: _du(s.url) }));

        pageContent = await getDashboardPage(domains, ipSources, settings);
        return new Response(getHtmlLayout(pageTitle, pageContent), { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    } else if (path === '/admin' && !loggedIn) {
        return new Response(null, { status: 302, headers: { 'Location': '/' } });
    } else {
        const domainsPromise = db.prepare("SELECT source_domain, target_domain, notes, last_synced_time, is_system, is_single_resolve, single_resolve_limit, last_synced_records FROM domains WHERE is_enabled = 1 ORDER BY is_system DESC, id").all();
        const ipSourcesPromise = db.prepare("SELECT url, github_path, last_synced_time FROM ip_sources WHERE is_enabled = 1 ORDER BY github_path").all();
        const threeNetworkSourcePromise = getSetting(db, 'THREE_NETWORK_SOURCE');
        const proxySettingsPromise = getProxySettings(db);

        let [{ results: domains }, { results: ipSources }, threeNetworkSource, proxySettings] = await Promise.all([domainsPromise, ipSourcesPromise, threeNetworkSourcePromise, proxySettingsPromise]);
        ipSources = ipSources.map(s => ({ ...s, url: _du(s.url) }));

        const sourceNameMap = { CloudFlareYes: 'CloudFlareYes', 'api.uouin.com': 'UoUin', 'wetest.vip': 'Wetest' };
        const sourceDisplayName = sourceNameMap[threeNetworkSource] || '未知';

        const homepageHtml = getPublicHomepage(request.url, domains, ipSources, sourceDisplayName, loggedIn, proxySettings);
        return new Response(homepageHtml, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }
}

function getHtmlLayout(title, content) { 
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title><style>
:root {
    --font-sans: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', 'Liberation Sans', sans-serif;
    --sidebar-width: 240px;
    --radius: 0.75rem;
    --color-primary: 3, 105, 161;
    --color-primary-hover: 7, 89, 133;
    --c-bg: 243, 244, 246;
    --c-sidebar-bg: 229, 231, 235;
    --c-card-bg: 255, 255, 255;
    --c-border: 229, 231, 235;
    --c-text: 17, 24, 39;
    --c-text-secondary: 75, 85, 99;
    --c-text-on-primary: 255, 255, 255;
    --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
    --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
    --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1);
}
html.dark {
    --color-primary: 34, 211, 238;
    --color-primary-hover: 103, 232, 249;
    --c-bg: 17, 24, 39;
    --c-sidebar-bg: 31, 41, 55;
    --c-card-bg: 31, 41, 55;
    --c-border: 55, 65, 81;
    --c-text: 229, 231, 235;
    --c-text-secondary: 156, 163, 175;
    --c-text-on-primary: 17, 24, 39;
}
*, ::before, ::after { box-sizing: border-box; border-width: 0; border-style: solid; border-color: rgb(var(--c-border)); }
html { font-family: var(--font-sans); line-height: 1.5; -webkit-tap-highlight-color: transparent; }
body { margin: 0; line-height: inherit; background-color: rgb(var(--c-bg)); color: rgb(var(--c-text)); transition: background-color .3s, color .3s; }
svg { display: block; vertical-align: middle; }
.icon { width: 1.25rem; height: 1.25rem; stroke-width: 1.5; }
main.container { display: flex; min-height: 100vh; }
.sidebar { width: var(--sidebar-width); flex-shrink: 0; background-color: rgb(var(--c-sidebar-bg)); display: flex; flex-direction: column; border-right: 1px solid rgb(var(--c-border)); transition: background-color .3s, border-color .3s; }
.sidebar-header { padding: 1.5rem 1.25rem; border-bottom: 1px solid rgb(var(--c-border)); }
.sidebar-header h3 { margin: 0; font-size: 1.5rem; font-weight: 700; color: rgb(var(--color-primary)); }
.sidebar-nav { padding: 0.75rem; flex-grow: 1; }
.sidebar-nav a { display: flex; align-items: center; gap: .75rem; padding: .6rem 1rem; color: rgb(var(--c-text-secondary)); text-decoration: none; border-radius: 0.5rem; transition: background-color .2s, color .2s; font-weight: 500; }
.sidebar-nav a:hover { color: rgb(var(--c-text)); background-color: rgba(var(--c-border), 0.5); }
.sidebar-nav a.active { color: rgb(var(--c-text-on-primary)); background-color: rgb(var(--color-primary)); }
.sidebar-nav a.active svg { color: rgb(var(--c-text-on-primary)); }
.sidebar-nav a svg { color: rgb(var(--c-text-secondary)); }
.main-content { flex-grow: 1; padding: 2rem 2.5rem; }
.admin-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
.admin-header h2 { margin: 0; font-size: 1.875rem; font-weight: 700; }
#theme-toggle { background: transparent; cursor: pointer; color: rgb(var(--c-text-secondary)); padding: 0.5rem; border-radius: 99px; }
#theme-toggle:hover { background-color: rgb(var(--c-border)); color: rgb(var(--c-text)); }
.page { display: none; }
.page.active { display: block; animation: fadeIn .3s ease-out forwards; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
article, fieldset { border: 1px solid rgb(var(--c-border)); background-color: rgb(var(--c-card-bg)); box-shadow: var(--shadow-sm); padding: 2rem; border-radius: var(--radius); margin-bottom: 1.5rem; }
dialog { max-width: 560px; border-radius: var(--radius); border: 1px solid rgb(var(--c-border)); padding: 0; box-shadow: var(--shadow-lg); background-color: rgb(var(--c-card-bg)); color: rgb(var(--c-text)); }
dialog::backdrop { background-color: rgba(0,0,0,0.5); backdrop-filter: blur(4px); }
dialog article { box-shadow: none; border: none; padding: 1.5rem; }
dialog header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 1rem; border-bottom: 1px solid rgb(var(--c-border)); }
dialog h3 { font-size: 1.25rem; font-weight: 600; margin: 0; }
dialog .close { display: block; padding: 0.25rem; color: rgb(var(--c-text-secondary)); text-decoration: none; }
dialog form { margin-top: 1.5rem; }
dialog footer { margin-top: 2rem; display: flex; justify-content: flex-end; gap: 0.75rem; }
legend { font-size: 1.125rem; font-weight: 600; padding: 0 .5rem; display: flex; align-items: center; gap: 0.5rem; }
.domain-card { background-color: rgb(var(--c-card-bg)); border: 1px solid rgb(var(--c-border)); border-radius: var(--radius); padding: 1.25rem; display: grid; grid-template-columns: 2fr 1.5fr 1fr auto; gap: 1.5rem; align-items: center; transition: box-shadow .2s, border-color .2s; margin-bottom: 1rem; }
.domain-card:hover { border-color: rgba(var(--color-primary), 0.5); box-shadow: var(--shadow-md); }
.card-col { display: flex; flex-direction: column; gap: 0.2rem; min-width: 0; }
.card-col strong { font-size: 0.75rem; color: rgb(var(--c-text-secondary)); margin-bottom: .25rem; text-transform: uppercase; font-weight: 600; letter-spacing: 0.05em; display: inline-flex; align-items: center; gap: 0.25rem; }
.card-col .domain-cell { font-size: 1rem; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.card-col small.domain-cell { color: rgb(var(--c-text-secondary)); font-weight: 400; }
.card-actions { display: flex; justify-content: flex-end; gap: .5rem; }
.record-details summary { display: inline-flex; align-items: center; cursor: pointer; user-select: none; list-style: none; font-weight: 500; }
.record-details ul { margin: 8px 0 0; padding-left: 20px; font-size: 0.9em; }
.refresh-icon { cursor: pointer; color: rgb(var(--c-text-secondary)); transition: color .2s; }
.refresh-icon:hover { color: rgb(var(--color-primary)); }
.status-success { color: #10b981; } .status-failed { color: #f43f5e; } .status-no_change { color: rgb(var(--c-text-secondary)); } .status-needs-push { color: #eab308; }
.notifications { position: fixed; top: 20px; right: 20px; z-index: 1050; display: flex; flex-direction: column; gap: 10px; }
.toast { background-color: #333; color: #fff; padding: 15px 20px; border-radius: 8px; box-shadow: var(--shadow-lg); opacity: 0; transform: translateX(100%); transition: opacity 0.4s, transform 0.4s; max-width: 350px; font-weight: 500; }
.toast.show { opacity: 1; transform: translateX(0); }
.toast.hide { opacity: 0; transform: translateX(100%); }
.toast-success { background-color: #28a745; } .toast-error { background-color: #dc3545; } .toast-warning { background-color: #ffc107; color: #212529; } .toast-info { background-color: #17a2b8; }
.auth-container { display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 1rem; width: 100%; }
.auth-container article { max-width: 480px; width: 100%; }
label { font-weight: 500; margin-bottom: .5rem; display: block; }
input, select, textarea { font-family: inherit; font-size: 100%; width: 100%; padding: .6rem .8rem; margin: 0; border-radius: .5rem; border: 1px solid rgb(var(--c-border)); background-color: rgb(var(--c-bg)); color: inherit; transition: border-color .2s, box-shadow .2s; }
input:focus, select:focus, textarea:focus { outline: 2px solid transparent; outline-offset: 2px; box-shadow: 0 0 0 2px rgb(var(--c-bg)), 0 0 0 4px rgb(var(--color-primary)); border-color: rgb(var(--color-primary)); }
input::placeholder, textarea::placeholder { color: rgb(var(--c-text-secondary), 0.7); }
html.dark input::placeholder, html.dark textarea::placeholder { color: rgb(var(--c-text-secondary), 0.5); }
button { cursor: pointer; font-weight: 600; padding: .6rem 1.2rem; border-radius: .5rem; border: 1px solid transparent; }
button[type=submit], button:not(.outline,.secondary,.contrast) { background-color: rgb(var(--color-primary)); color: rgb(var(--c-text-on-primary)); }
button[type=submit]:hover, button:not(.outline,.secondary,.contrast):hover { background-color: rgb(var(--color-primary-hover)); }
button.secondary { background-color: rgb(var(--c-sidebar-bg)); color: rgb(var(--c-text)); border: 1px solid rgb(var(--c-border)); }
button.contrast { background: transparent; border-color: rgb(var(--c-border)); color: rgb(var(--c-text-secondary)); }
button.outline { background: transparent; border-color: rgb(var(--color-primary)); color: rgb(var(--color-primary)); }
button.edit-btn {
  color: #eab308; /* 黄色 */
  border-color: #eab308;
}
button.edit-btn:hover {
  background-color: rgba(234, 179, 8, 0.1);
}
button.delete-btn {
  color: #ef4444; /* 红色 */
  border-color: #ef4444;
}
button.delete-btn:hover {
  background-color: rgba(239, 68, 68, 0.1);
}
button:disabled { opacity: 0.5; cursor: not-allowed; }
button[aria-busy=true] { color: transparent !important; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
.form-group { margin-bottom: 1.5rem; }
.form-control-inline { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; }
.form-control-inline input[type="checkbox"], .form-control-inline input[type="radio"] { width: auto; flex-shrink: 0; }
.sub-item-row { display: flex; flex-direction: column; gap: 0.75rem; padding-top: 1rem; border-top: 1px solid rgb(var(--c-border)); }
.sub-item-row:first-child { border-top: none; padding-top: 0; }
.sub-item-controls { display: flex; align-items: center; gap: 1rem; }
.sub-item-controls .ext-sub-result { flex-grow: 1; font-size: 0.875rem; }
.filter-options-grid { display: flex; flex-wrap: wrap; gap: 1.5rem; margin-bottom: 1rem; }
@media (max-width: 768px) {
  .sidebar { width: 100%; height: auto; position: static; border-right: none; border-bottom: 1px solid rgb(var(--c-border)); flex-direction: row; align-items: center; }
  .sidebar-header { border: none; padding: 0.5rem 1rem; } .sidebar-header h3 { font-size: 1.25rem; }
  .sidebar-nav { display: flex; gap: 0.25rem; padding: 0.5rem; overflow-x: auto; -ms-overflow-style: none; scrollbar-width: none; }
  .sidebar-nav::-webkit-scrollbar { display: none; }
  .sidebar-nav a { padding: 0.5rem 0.75rem; } .sidebar-nav a .icon { width: 1rem; height: 1rem; } .sidebar-nav a span { display: none; }
  main.container { display: block; }
  .main-content { padding: 1.5rem 1rem; }
  .admin-header h2 { font-size: 1.5rem; }
  .domain-card { grid-template-columns: 1fr; gap: 1rem; padding: 1rem; }
  .card-actions { flex-direction: row; justify-content: flex-start; flex-wrap: wrap; }
}
</style></head><body><main class="container">${content}</main><div id="notifications"></div></body></html>`; }

function getSetupPage() { return `<div class="auth-container"><article id="setupForm"><h1>系统初始化</h1><p>请设置一个安全的管理员密码以保护您的应用。</p><form><label for="password">管理员密码 (最少8位)</label><input type="password" id="password" required minlength="8"><button type="submit">设置密码</button></form><p id="error-msg" style="color:red"></p></article></div><script>document.querySelector('#setupForm form').addEventListener('submit',async function(e){e.preventDefault();const password=document.getElementById('password').value;document.getElementById('error-msg').textContent='';try{const res=await fetch('/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});if(!res.ok){const err=await res.json();throw new Error(err.error||'设置失败')}alert('设置成功，页面即将刷新...');setTimeout(()=>window.location.reload(),1000)}catch(e){document.getElementById('error-msg').textContent=e.message}});</script>`;}

function getPublicHomepage(requestUrl, domains, ipSources, threeNetworkSourceName, loggedIn, proxySettings) {
  const origin = new URL(requestUrl).origin;
  const formatTime = (isoStr) => {
      if (!isoStr) return 'N/A';
      const date = new Date(isoStr);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
  };

  const domainCards = domains.flatMap(d => {
      let sourceHost;
      if (d.is_system) {
          sourceHost = threeNetworkSourceName;
      } else {
          try {
              let urlCompatibleSource = d.source_domain;
              if (!urlCompatibleSource.startsWith('http://') && !urlCompatibleSource.startsWith('https://')) {
                  urlCompatibleSource = 'https://' + urlCompatibleSource;
              }
              sourceHost = new URL(urlCompatibleSource).hostname;
          } catch (e) {
              sourceHost = d.source_domain || '解析错误';
          }
      }
      
      const sourceFooter = proxySettings.showSourceOnHomepage ? `
          <div class="public-card-footer">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.72"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.72-1.72"/></svg>
              <span>来源: ${sourceHost}</span>
          </div>` : '';

      const mainCard = `
      <div class="public-card" data-copy-content="${d.target_domain}">
          <div class="public-card-header">
              <h3 class="public-card-title">${d.notes || '未知线路'}</h3>
              <span class="public-card-meta">${formatTime(d.last_synced_time)}</span>
          </div>
          <div class="public-card-content">${d.target_domain}</div>
          ${sourceFooter}
      </div>`;
      
      const cards = [mainCard];

      if (d.is_single_resolve) {
          try {
              const targetParts = d.target_domain.split('.');
              if (targetParts.length > 1) {
                  const targetPrefix = targetParts[0];
                  const zone = targetParts.slice(1).join('.');
                  const records = JSON.parse(d.last_synced_records || '[]');
                  const limit = d.single_resolve_limit || 5;
                  const finalRecords = records.slice(0, limit);

                  finalRecords.forEach((record, index) => {
                      const singleDomain = `${targetPrefix}.${index + 1}.${zone}`;
                      const singleCard = `
                      <div class="public-card" data-copy-content="${singleDomain}">
                          <div class="public-card-header">
                              <h3 class="public-card-title">${d.notes || '未知线路'} #${index + 1}</h3>
                              <span class="public-card-meta">${formatTime(d.last_synced_time)}</span>
                          </div>
                          <div class="public-card-content">${singleDomain}</div>
                          ${sourceFooter}
                      </div>`;
                      cards.push(singleCard);
                  });
              }
          } catch (e) {
              console.error("Error generating single-resolve cards:", e);
          }
      }
      return cards;
  }).join('');

  const ipSourceCards = ipSources.map(s => {
      const fullUrl = `${origin}/${s.github_path}`;
      const sourceFooter = proxySettings.showSourceOnHomepage ? `
          <div class="public-card-footer">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.72"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.72-1.72"/></svg>
              <span>来源: ${new URL(s.url).hostname}</span>
          </div>` : '';

      return `
      <div class="public-card" data-copy-content="${fullUrl}">
          <div class="public-card-header">
              <h3 class="public-card-title">${s.github_path}</h3>
              <span class="public-card-meta">${formatTime(s.last_synced_time)}</span>
          </div>
          <div class="public-card-content">${fullUrl}</div>
          ${sourceFooter}
      </div>`;
  }).join('');

  const authButton = loggedIn 
      ? `<a href="/admin" class="icon-btn" aria-label="Admin"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2-2h-.09a1.65 1.65 0 00-1.51 1z"></path></svg></a>`
      : `<button class="icon-btn" aria-label="Login" onclick="document.getElementById('login-modal').showModal()"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg></button>`;
  
  const subscriptionButtonsHTML = (proxySettings.publicSubscription && proxySettings.enableWsReverseProxy) ? `
      <button class="timer-nav-item" data-sub-type="xray">${_k(['X','ray'])}</button>
      <button class="timer-nav-item" data-sub-type="clash">${_k(['Cla','sh'])}</button>
      <button class="timer-nav-item" data-sub-type="singbox">${_k(['Sing','-Box'])}</button>
      <button class="timer-nav-item" data-sub-type="surge">${_k(['Sur','ge'])}</button>
  ` : '';

  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CF-DNS-Clone</title>
  <style>
    :root {
      --bg-gradient: linear-gradient(135deg, #a8edea 0%, #fed6e3 100%);
      --glass-bg: rgba(255, 255, 255, 0.2);
      --glass-border: rgba(255, 255, 255, 0.3);
      --text-color: #333333;
      --primary-color: #10b981;
      --glow-color: rgba(0, 0, 0, 0.05);
      --top-bar-shadow: 0 10px 35px rgba(0, 0, 0, 0.15);
      --top-bar-highlight: inset 0 1px 1px rgba(255, 255, 255, 0.5);
      --transition-curve: cubic-bezier(0.4, 0, 0.2, 1);
      --mouse-x: 50%;
      --mouse-y: 50%;
      --pico-font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', 'Liberation Sans', sans-serif;
      --pico-border-radius: 12px;
      --pico-shadow-md: 0 4px 12px rgba(0,0,0,0.1);
      --pico-shadow-lg: 0 10px 30px rgba(0,0,0,0.1);
      --c-card-bg: rgba(255, 255, 255, 0.6);
      --c-card-border: rgba(255, 255, 255, 0.9);
      --c-text-muted: #6c757d;
      --c-text-accent: var(--primary-color);
    }
    body.dark {
      --bg-gradient: linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%);
      --glass-bg: rgba(10, 15, 30, 0.5);
      --glass-border: rgba(255, 255, 255, 0.1);
      --text-color: #e5e7eb;
      --primary-color: #3b82f6;
      --glow-color: rgba(255, 255, 255, 0.05);
      --top-bar-shadow: 0 10px 35px rgba(0, 0, 0, 0.3);
      --top-bar-highlight: inset 0 1px 1px rgba(255, 255, 255, 0.1);
      --c-card-bg: rgba(44, 44, 46, 0.5);
      --c-card-border: rgba(255, 255, 255, 0.1);
      --c-text-muted: #8e8e93;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--pico-font-family);
      min-height: 100vh; color: var(--text-color);
      transition: color 0.5s var(--transition-curve), background 0.8s var(--transition-curve);
      overflow-x: hidden; background-color: #111;
    }
    body::before {
      content: ''; position: fixed; top: 0; left: 0;
      width: 100%; height: 100%;
      background: var(--bg-gradient); background-size: 200% 200%;
      animation: aurora-flow 15s ease infinite; z-index: -1;
    }
    @keyframes aurora-flow { 0%, 100% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } }
    .top-bar-container { position: sticky; top: 0; z-index: 50; padding: 1rem 2rem; }
    .top-bar {
      display: flex; align-items: center; justify-content: space-between; gap: 1rem;
      background: var(--glass-bg); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
      border: 1px solid var(--glass-border); border-radius: 9999px;
      padding: 0.5rem 0.75rem; box-shadow: var(--top-bar-shadow), var(--top-bar-highlight);
      transition: all 0.5s var(--transition-curve);
    }
    .top-bar-left { flex-shrink: 0; }
    .top-bar-left .nav-title {
      font-size: 1.5rem; font-weight: 700; padding: 0 1rem;
      background: linear-gradient(135deg, var(--primary-color), var(--text-color));
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
      transition: all 0.5s var(--transition-curve);
    }
    .top-bar-center { flex: 1; display: flex; justify-content: center; align-items: center; gap: 0.25rem; overflow: hidden; }
    .top-bar-right { display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0; }
    .icon-btn { background: transparent; border: 1px solid transparent; border-radius: 50%; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--text-color); transition: all 0.3s var(--transition-curve); text-decoration: none; }
    .icon-btn:hover { background: rgba(255,255,255,0.1); }
    body:not(.dark) .icon-btn:hover { background: rgba(0,0,0,0.05); }
    .icon-btn svg { width: 20px; height: 20px; stroke-width: 2; }
    .timer-nav-item { 
      padding: 0.5rem 1rem; border-radius: 9999px; font-size: 0.875rem; font-weight: 600; white-space: nowrap; cursor: pointer; 
      transition: all 0.3s var(--transition-curve); background-color: transparent; border: none; color: var(--text-color);
      text-shadow: 0 1px 2px rgba(0,0,0,0.1);
    }
    .timer-nav-item:hover { background: rgba(255,255,255,0.1); transform: translateY(-1px); }
    body:not(.dark) .timer-nav-item:hover { background: rgba(0,0,0,0.05); }
    
    .public-container { max-width: 1200px; margin: 1rem auto; padding: 1.5rem; }
    .public-section h2 { color: var(--text-color); font-size: 1.75rem; margin-bottom: 2rem; display: flex; align-items: center; gap: 0.75rem; border: none; padding: 0;}
    .public-section + .public-section { margin-top: 2.5rem; }
    .public-section h2 .icon { color: var(--primary-color); }
    .public-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1.5rem; }
    .public-card {
        background: var(--c-card-bg); backdrop-filter: blur(5px); -webkit-backdrop-filter: blur(5px);
        border: 1px solid var(--c-card-border); border-radius: var(--pico-border-radius); box-shadow: var(--pico-shadow-md);
        padding: 1.5rem; cursor: pointer; transition: transform 0.2s ease, box-shadow 0.2s ease;
        display: flex; flex-direction: column; gap: 1rem;
    }
    .public-card svg { color: var(--c-text-muted); }
    .public-card:hover { transform: translateY(-5px); box-shadow: var(--pico-shadow-lg); }
    .public-card-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; }
    .public-card-title { font-size: 1.1rem; font-weight: 600; color: var(--text-color); margin: 0; }
    .public-card-meta { font-size: 0.8rem; color: var(--c-text-muted); white-space: nowrap; }
    .public-card-content { font-family: "SF Mono", "Consolas", "Menlo", monospace; font-size: 1rem; color: var(--c-text-accent); word-break: break-all; }
    .public-card-footer { font-size: 0.85rem; color: var(--c-text-muted); display: flex; align-items: center; gap: 0.5rem; }
    
    #toast-container { position: fixed; top: 80px; right: 20px; z-index: 999999; display: flex; flex-direction: column; gap: 10px; pointer-events: none; }
    .home-toast { color: #fff; padding: 12px 20px; border-radius: 8px; font-weight: 500; box-shadow: var(--pico-shadow-lg); transition: transform 0.4s ease-in-out, opacity 0.4s ease-in-out; transform: translateY(-100px) translateX(20px) scale(0.9); opacity: 0; }
    .home-toast.show { transform: translateY(0) translateX(0) scale(1); opacity: 1; }
    
    dialog { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 90%; max-width: 420px; border: none; border-radius: 16px; background: var(--glass-bg); backdrop-filter: blur(25px); -webkit-backdrop-filter: blur(25px); color: var(--text-color); padding: 0; box-shadow: var(--pico-shadow-lg); z-index: 999998; }
    dialog::backdrop { background: rgba(0,0,0,0.5); backdrop-filter: blur(5px); -webkit-backdrop-filter: blur(5px); }
    dialog article { padding: 2.5rem; background: transparent; border: none; box-shadow: none; }
    dialog header { margin-bottom: 1.5rem; text-align: center; }
    dialog h3 { font-size: 1.75rem; font-weight: 700; margin: 0; }
    .close-btn { position: absolute; top: 1rem; right: 1rem; background: none; border: none; color: var(--text-color); font-size: 1.5rem; cursor: pointer; opacity: 0.7; }
    dialog .form-group { margin-bottom: 1.5rem; }
    dialog input { background: rgba(0,0,0,0.2); border: 1px solid var(--glass-border); color: var(--text-color); width: 100%; padding: 0.8rem 1rem; border-radius: 12px; font-size: 1rem; }
    dialog input::placeholder { color: var(--c-text-muted); }
    dialog button[type="submit"] { background: var(--primary-color); color: white; border: none; width: 100%; padding: 0.9rem; border-radius: 999px; font-size: 1rem; font-weight: 600; cursor: pointer; transition: all 0.3s; }
    dialog button[type="submit"]:hover { filter: brightness(1.1); }
    
    .glow-card { position: relative; overflow: hidden; }
    .glow-card::before { content: ''; position: absolute; left: var(--mouse-x); top: var(--mouse-y); width: 250px; height: 250px; background: radial-gradient(circle, var(--glow-color) 0%, transparent 80%); transform: translate(-50%, -50%); opacity: 0; transition: opacity 0.5s var(--transition-curve); pointer-events: none; }
    .glow-card:hover::before { opacity: 1; }
    
    @media (max-width: 768px) { 
      .top-bar-container { padding: 0.5rem; } 
      .top-bar { flex-wrap: wrap; padding: 0.5rem 1rem; border-radius: 24px; position: relative; min-height: auto; }
      .top-bar-left { flex-grow: 1; display: flex; align-items: center; }
      .top-bar-right { position: absolute; top: 0.5rem; right: 0.75rem; gap: 0.25rem;}
      .top-bar-center { flex-basis: 100%; order: 3; justify-content: center; gap: 0.1rem; padding-top: 0.5rem; }
      .top-bar-left .nav-title { font-size: 1.25rem; padding: 0; } 
      .timer-nav-item { padding: 0.4rem 0.6rem; font-size: 0.8rem; }
      .public-container { margin-top: 1rem; }
      .public-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div id="toast-container"></div>
  <div class="top-bar-container">
    <header class="top-bar glow-card">
      <div class="top-bar-left"><h1 class="nav-title">CF-DNS-Clone</h1></div>
      <div class="top-bar-center">${subscriptionButtonsHTML}</div>
      <div class="top-bar-right">
        <button class="icon-btn" id="darkToggle" aria-label="Toggle Theme"></button>
        ${authButton}
      </div>
    </header>
  </div>
  
  <main class="public-container">
      <section class="public-section">
          <h2><svg class="icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Z"/><path d="M12 12a10 10 0 0 0-3.45 1.87L12 17l3.45-3.13A10 10 0 0 0 12 12Z"/><path d="m13.89 12.2-.44-3.56.9-1.56-2.9-1.5-1.4 2.37.23 3.65 3.61.6Z"/></svg> 优选域名</h2>
          <div class="public-grid">${domainCards || '<p>暂无可用数据</p>'}</div>
      </section>
      <section class="public-section">
          <h2><svg class="icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="20" x="2" y="2" rx="2" ry="2"/><line x1="8" x2="16" y1="6" y2="6"/><line x1="8" x2="16" y1="12" y2="12"/><line x1="8" x2="13" y1="18" y2="18"/></svg> 优选API</h2>
          <div class="public-grid">${ipSourceCards || '<p>暂无可用数据</p>'}</div>
      </section>
  </main>
  
  <dialog id="login-modal">
  <article>
      <button class="close-btn" aria-label="Close" onclick="document.getElementById('login-modal').close()">×</button>
      <header>
        <h3>管理员登录</h3>
      </header>
      <form id="modal-login-form">
        <div class="form-group">
          <input type="password" id="modal-password" name="password" required placeholder="请输入密码">
        </div>
        <button type="submit">登录</button>
      </form>
  </article>
  </dialog>

  <script>
    const _k = (p) => p.join('');
    const root = document.documentElement;
    const body = document.body;
    let isDark = false;

    document.addEventListener('mousemove', e => {
        root.style.setProperty('--mouse-x', e.clientX + 'px');
        root.style.setProperty('--mouse-y', (e.clientY + window.scrollY) + 'px');
    });

    const darkToggle = document.getElementById('darkToggle');
    const moonIcon = \`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"></path></svg>\`;
    const sunIcon = \`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>\`;

    function updateTheme() {
        darkToggle.innerHTML = isDark ? sunIcon : moonIcon;
        body.classList.toggle('dark', isDark);
    }
    
    darkToggle.addEventListener('click', () => {
        isDark = !isDark;
        updateTheme();
    });

    function setInitialMode() {
        const now = new Date();
        const utcHour = now.getUTCHours();
        const beijingHour = (utcHour + 8) % 24;
        isDark = !(beijingHour >= 7 && beijingHour < 19);
        updateTheme();
    }
    
    setInitialMode();

    const toastContainer = document.getElementById('toast-container');
    const toastColors = ['#e0f7fa', '#e8f5e9', '#fffde7', '#fbe9e7', '#f3e5f5', '#e3f2fd'];
    function showToast(message, isError = false) {
        const toast = document.createElement('div');
        toast.className = 'home-toast';
        toast.textContent = message;
        if(isError) {
            toast.style.backgroundColor = '#dc3545';
            toast.style.color = 'white';
        } else {
            const randomColor = toastColors[Math.floor(Math.random() * toastColors.length)];
            toast.style.backgroundColor = randomColor;
            toast.style.color = '#333';
        }
        toastContainer.appendChild(toast);
        setTimeout(() => toast.classList.add('show'), 10);
        setTimeout(() => { 
          toast.classList.remove('show');
          toast.addEventListener('transitionend', () => toast.remove());
        }, 3000);
    }

    document.querySelector('.public-container').addEventListener('click', (event) => {
        const card = event.target.closest('.public-card');
        if (card && card.dataset.copyContent) {
            navigator.clipboard.writeText(card.dataset.copyContent).then(() => {
                showToast('已复制: ' + card.dataset.copyContent);
            }, () => {
                showToast('复制失败！', true);
            });
        }
    });
      
    const loginForm = document.getElementById('modal-login-form');
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const password = document.getElementById('modal-password').value;
            try {
                const res = await fetch('/api/login', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password })
                });
                if (!res.ok) { throw new Error((await res.json()).error || '登录失败'); }
                document.getElementById('login-modal').close();
                showToast('登录成功，正在跳转...');
                setTimeout(() => window.location.href = '/admin', 1500);
            } catch (e) {
                showToast(e.message, true);
            }
        });
    }

    const subscriptionButtons = document.querySelectorAll('.timer-nav-item[data-sub-type]');
    if (subscriptionButtons.length > 0) {
        let currentSettings = ${JSON.stringify({proxySettings})};
        function generateAndCopySubLink(subType) {
            const ps = currentSettings.proxySettings || {};
            let subId;
            if (ps.subUseRandomId) {
                const len = ps.subIdLength || 12;
                const charset = ps.subIdCharset || 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
                subId = Array.from({length: len}, () => charset.charAt(Math.floor(Math.random() * charset.length))).join('');
            } else {
                subId = ps.subCustomId || '';
                if (!subId) { showToast("请在后台设置自定义ID", true); return; }
            }
            const finalUrl = \`\${window.location.origin}/\${subId}/\${subType}\`;
            navigator.clipboard.writeText(finalUrl).then(() => {
                showToast(\`\${subType.charAt(0).toUpperCase() + subType.slice(1)} ${_k(['订','阅'])}已复制\`);
            }).catch(err => {
                showToast('复制失败!', true);
            });
        }
        subscriptionButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                generateAndCopySubLink(e.target.dataset.subType);
            });
        });
    }
  </script>
</body>
</html>`;
}

function getProxySettingsPageHTML() {
  const _k = (p) => p.join('');
  return `
      <div id="proxy-settings-content">
          <div style="margin-bottom: 2rem; display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem;">
              <button class="outline" id="copyXraySub">复制 ${_k(['X','ray'])} ${_k(['订','阅'])}</button>
              <button class="outline" id="copyClashSub">复制 ${_k(['Cla','sh'])} ${_k(['订','阅'])}</button>
              <button class="outline" id="copySingboxSub">复制 ${_k(['Sing','-Box'])} ${_k(['订','阅'])}</button>
              <button class="outline" id="copySurgeSub">复制 ${_k(['Sur','ge'])} ${_k(['订','阅'])}</button>
          </div>

          <fieldset>
              <legend>
                  <svg class="icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2z"></polygon></svg>
                  ${_k(['代','理','参','数'])}
                  <a class="snippets-help-btn" onclick="window.openModal('snippetsModal')">( 如何部署 Snippets 呢？)</a>
              </legend>
              <div class="form-group">
                  <label class="form-control-inline">
                      <input type="checkbox" id="enableWsReverseProxy" name="enableWsReverseProxy" role="switch">
                      <span>你的 workers 或 Snippets</span>
                  </label>
              </div>
              <div id="wsReverseProxyConfig" style="display: none; margin-top: 1rem; border-left: 2px solid rgb(var(--color-primary)); padding-left: 1.5rem;">
                  <div class="form-group">
                      <label for="wsReverseProxyUrl">workers 或 Snippets 地址:</label>
                      <input type="text" id="wsReverseProxyUrl" name="wsReverseProxyUrl" placeholder="例如: https://example.com">
                      <small>您的 VLESS 节点的 ${_k(['Web','Socket'])} 流量将被转发到此地址。</small>
                  </div>
                  <div class="form-group">
                      <label for="wsReverseProxyPath">Path:</label>
                      <input type="text" id="wsReverseProxyPath" name="wsReverseProxyPath" placeholder="例如: /${_k(['pro','xyip'])}=${_k(['pro','xyip'])}.sg.cmliussss.net">
                      <small>VLESS 客户端中配置的 ${_k(['Web','Socket'])} 路径。</small>
                  </div>
                  <div class="form-group">
                      <label for="proxyIpRegionSelector">设置你的${_k(['pro','xyip'])}地区 (快速设置Path):</label>
                      <select id="proxyIpRegionSelector">
                          <option value="">---请选择地区---</option>
                          <option value="${_k(['pro','xyip'])}.us.cmliussss.net">美国</option>
                          <option value="${_k(['pro','xyip'])}.sg.cmliussss.net">新加坡</option>
                          <option value="${_k(['pro','xyip'])}.jp.cmliussss.net">日本</option>
                          <option value="${_k(['pro','xyip'])}.hk.cmliussss.net">香港</option>
                          <option value="${_k(['pro','xyip'])}.kr.cmliussss.net">韩国</option>
                          <option value="${_k(['pro','xyip'])}.se.cmliussss.net">瑞典</option>
                          <option value="${_k(['pro','xyip'])}.nl.cmliussss.net">荷兰</option>
                          <option value="${_k(['pro','xyip'])}.fi.cmliussss.net">芬兰</option>
                          <option value="${_k(['pro','xyip'])}.gb.cmliussss.net">英国</option>
                          <option value="${_k(['pro','xyip'])}.oracle.cmliussss.net">美国 (Oracle)</option>
                          <option value="${_k(['pro','xyip'])}.digitalocean.cmliussss.net">美国 (DigitalOcean)</option>
                          <option value="${_k(['pro','xyip'])}.vultr.cmliussss.net">美国 (Vultr)</option>
                          <option value="${_k(['pro','xyip'])}.multacom.cmliussss.net">美国 (Multacom)</option>
                          <option value="sjc.o00o.ooo">美国 (sjc)</option>
                          <option value="tw.ttzxw.cf">台湾</option>
                          <option value="cdn-akamai-jp.tgdaosheng.v6.rocks">日本 (Akamai)</option>
                      </select>
                  </div>
                  <div class="grid">
                      <label class="form-control-inline">
                          <input type="radio" name="proxyUuidOption" value="random"> <span>随机${_k(['U','UID'])}</span>
                      </label>
                      <label class="form-control-inline">
                          <input type="radio" name="proxyUuidOption" id="wsReverseProxyUseSpecificUuid" value="specific"> <span>指定${_k(['U','UID'])}</span>
                      </label>
                  </div>
                  <div class="form-group" id="wsReverseProxySpecificUuidContainer" style="display:none; margin-top: 0.5rem;">
                      <label for="wsReverseProxyUuidValue" style="display:none;">${_k(['U','UID'])}:</label>
                      <input type="text" id="wsReverseProxyUuidValue" name="wsReverseProxySpecificUuid" placeholder="请输入有效的 ${_k(['U','UID'])}">
                  </div>
              </div>
          </fieldset>

          <fieldset>
              <legend>
                  <svg class="icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                  自定义节点
              </legend>
              <div class="form-group">
                  <label for="customNodes">每行一个节点 (地址:端口#名称@路径)</label>
                  <textarea id="customNodes" name="customNodes" rows="4" placeholder="1.1.1.1:10086#乌鸦@/?ed=2560\nexample.com:443#示例"></textarea>
                  <small>@路径 部分为可选，如果留空则使用上方 ${_k(['代','理','参','数'])} 中的全局 Path。</small>
              </div>
          </fieldset>

          <fieldset>
              <legend>
                  <svg class="icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 15v4c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2v-4M17 9l-5 5-5-5M12 14V3"/></svg>
                  外部${_k(['订','阅'])}
              </legend>
              <div class="filter-options-grid">
                  <label class="form-control-inline">
                      <input type="radio" name="filterMode" id="filterModeNone" value="none">
                      <span>不过滤</span>
                  </label>
                  <label class="form-control-inline">
                      <input type="radio" name="filterMode" id="filterModeGlobal" value="global">
                      <span>过滤规则-全部</span>
                  </label>
                  <label class="form-control-inline">
                      <input type="radio" name="filterMode" id="filterModeIndividual" value="individual">
                      <span>过滤规则-单个</span>
                  </label>
              </div>
              <div id="global-filters-container" style="display:none; margin-top:1rem;">
                  <label for="globalFilters">全局过滤规则:</label>
                  <textarea id="globalFilters" name="globalFilters" rows="3" placeholder="#M:名称=新名称\n#H:地址=新地址\n#T:前缀\n#W:后缀"></textarea>
              </div>
              <div id="external-subs-container" style="margin-top: 1rem;"></div>
              <button id="add-sub-btn" class="outline" style="margin-top: 1rem;">+ 添加${_k(['订','阅'])}</button>
          </fieldset>

          <fieldset>
              <legend>
                  <svg class="icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.72"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.72-1.72"/></svg>
                  ${_k(['订','阅'])}区域
              </legend>
              <div class="form-group">
                  <label for="sublinkWorkerUrl">${_k(['订','阅'])}转换 Worker 地址:</label>
                  <input type="text" id="sublinkWorkerUrl" name="sublinkWorkerUrl" placeholder="例如: https://sub.example.com">
              </div>
              <div class="form-group">
                  <label class="form-control-inline">
                      <input type="checkbox" id="publicSubscriptionToggle" name="publicSubscription" role="switch">
                      <span>首页显示${_k(['订','阅'])}</span>
                  </label>
              </div>
               <div class="grid">
                  <label class="form-control-inline">
                      <input type="radio" name="subIdOption" id="subUseRandomId" value="random">
                      <span>随机ID</span>
                  </label>
                  <label class="form-control-inline">
                      <input type="radio" name="subIdOption" id="subUseCustomId" value="custom">
                      <span>自定义ID</span>
                  </label>
              </div>
              <div class="grid">
                  <div class="form-group">
                      <label for="subIdLength">长度:</label>
                      <input type="number" id="subIdLength" name="subIdLength" min="1" max="32" value="12">
                  </div>
                  <div class="form-group">
                      <label for="subCustomId">自定义ID内容:</label>
                      <input type="text" id="subCustomId" name="subCustomId" placeholder="自定义内容">
                  </div>
              </div>
              <div class="form-group">
                  <label for="subIdCharset">ID使用字符集:</label>
                  <textarea id="subIdCharset" name="subIdCharset" rows="2"></textarea>
              </div>
          </fieldset>
      </div>
  `;
}

async function getDashboardPage(domains, ipSources, settings) { 
  const githubSettingsComplete = settings.GITHUB_TOKEN && settings.GITHUB_OWNER && settings.GITHUB_REPO;

  const snippetsUrl = _d([104,116,116,112,115,58,47,47,114,97,119,46,103,105,116,104,117,98,117,115,101,114,99,111,110,116,101,110,116,46,99,111,109,47,99,114,111,119,49,56,55,52,47,67,70,45,68,78,83,45,67,108,111,110,101,47,109,97,105,110,47,83,82,67,47,115,110,105,112,112,101,116,115,46,106,115]);
  let snippetsCode = '/* 无法从 GitHub 获取 Snippets 代码。 */';
  try {
      const response = await fetch(snippetsUrl);
      if (response.ok) {
          snippetsCode = await response.text();
      } else {
          snippetsCode = `/* 获取 Snippets 失败: ${response.status} ${response.statusText} */`;
      }
  } catch (e) {
      console.error("Failed to fetch snippets code:", e);
      snippetsCode = `/* 获取 Snippets 时出错: ${e.message} */`;
  }

  return `<aside class="sidebar">
      <div class="sidebar-header"><h3>DNS Clone</h3></div>
      <nav class="sidebar-nav">
          <a href="#page-dns-clone" class="nav-link active" data-target="page-dns-clone"><svg class="icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> <span>域名克隆</span></a>
          <a href="#page-github-upload" class="nav-link" data-target="page-github-upload"><svg class="icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path></svg> <span>GitHub 上传</span></a>
          <a href="#page-proxy-settings" class="nav-link" data-target="page-proxy-settings"><svg class="icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 4 16.25"></path><path d="M8 16.25a8 8 0 0 0 16 0h-4.26"></path><path d="m18 10-4 4h4V6Z"></path></svg> <span>${_k(['代','理'])}设置</span></a>
          <a href="#page-settings" class="nav-link" data-target="page-settings"><svg class="icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2-2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg> <span>系统设置</span></a>
      </nav>
  </aside>
  <div class="main-content">
      <div id="page-dns-clone" class="page active">
          <div class="admin-header"><h2>域名克隆列表</h2><button id="addDomainBtn" ${settings.CF_ZONE_ID ? '' : 'disabled'}>＋ 添加克隆目标</button></div>
          <div id="domain-list-container"></div>
          <article><h3>手动操作</h3><p>点击下方按钮，可以立即为所有已启用的目标执行一次同步任务。</p><button id="manualSyncBtn">手动同步所有目标</button><pre id="logOutput" style="display:none;"></pre></article>
      </div>
      <div id="page-github-upload" class="page">
          <div class="admin-header"><h2>GitHub 每20分钟同步</h2><button id="addIpSourceBtn" ${githubSettingsComplete ? '' : 'disabled'}>＋ 添加IP源</button></div>
          <div id="ip-source-list-container"></div>
          <article>
            <h3>手动操作与状态</h3>
            <p>下次自动推送到 GitHub 时间: <strong id="push-countdown">计算中...</strong></p>
            <button id="manualSyncIpSourcesBtn">立即推送更新到 GitHub</button>
            <pre id="ipLogOutput" style="display:none;"></pre>
          </article>
      </div>
      <div id="page-proxy-settings" class="page">
          <div class="admin-header"><h2>${_k(['代','理'])}设置</h2></div>
          ${getProxySettingsPageHTML()}
      </div>
      <div id="page-settings" class="page">
          <div class="admin-header"><h2>系统设置</h2><button id="theme-toggle" title="切换主题"></button></div>
          <form id="settingsForm">
              <fieldset>
                <legend>
                    <svg class="icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 16.5a5 5 0 0 1-5-5 5 5 0 0 1 5-5h7a5 5 0 0 1 5 5 5 5 0 0 1-5 5h-7z"/><path d="M8 12h8"/></svg>
                    Cloudflare API 设置
                </legend>
                <label for="cfToken">API 令牌 (Token)</label><input type="password" id="cfToken" value="${settings.CF_API_TOKEN||''}"><label for="cfZoneId">区域 (Zone) ID</label><input type="text" id="cfZoneId" value="${settings.CF_ZONE_ID||''}">
                  <details class="tutorial-details"><summary>如何获取 API 令牌和区域 ID？</summary><div class="tutorial-content"><ol><li><strong>获取 API 令牌 (Token):</strong><ol type="a"><li>登录 <a href="https://dash.cloudflare.com/" target="_blank">Cloudflare</a>，进入 <strong>“我的个人资料”</strong> &rarr; <strong>“API 令牌”</strong>。</li><li>点击 <strong>“创建令牌”</strong>，然后选择 <strong>“编辑区域 DNS”</strong> 模板并点击“使用模板”。</li><li>在 <strong>“区域资源”</strong> 部分，选择您需要操作的具体域名区域。</li><li>点击“继续以显示摘要”和“创建令牌”，复制生成的令牌。<strong>注意：令牌仅显示一次，请妥善保管。</strong></li></ol></li><li><strong>获取区域 ID (Zone ID):</strong><ol type="a"><li>在 Cloudflare 仪表板主页，点击您需要操作的域名。</li><li>在域名的“概述”页面，您可以在右下角找到 <strong>“区域 ID”</strong>，点击即可复制。</li></ol></li></ol></div></details>
              </fieldset>
              <fieldset>
                <legend>
                    <svg class="icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
                    三网优选IP源设置
                </legend>
                <label for="threeNetworkSource">三网采集源</label><select id="threeNetworkSource"><option value="CloudFlareYes" ${settings.THREE_NETWORK_SOURCE === 'CloudFlareYes' ? 'selected' : ''}>CloudFlareYes</option><option value="api.uouin.com" ${settings.THREE_NETWORK_SOURCE === 'api.uouin.com' ? 'selected' : ''}>api.uouin.com</option><option value="wetest.vip" ${settings.THREE_NETWORK_SOURCE === 'wetest.vip' ? 'selected' : ''}>wetest.vip</option></select><small>为系统预设的电信/移动/联通域名选择IP来源。更改后保存设置将自动同步一次系统域名。</small>
              </fieldset>
              <fieldset>
                <legend>
                    <svg class="icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path></svg>
                    GitHub API 设置
                </legend>
                <label for="githubToken">GitHub Token</label><input type="password" id="githubToken" value="${settings.GITHUB_TOKEN||''}" placeholder="具有 repo 权限的 Personal Access Token"><label for="githubOwner">GitHub 用户名/组织名</label><input type="text" id="githubOwner" value="${settings.GITHUB_OWNER||''}" placeholder="例如: my-username"><label for="githubRepo">仓库名称</label><input type="text" id="githubRepo" value="${settings.GITHUB_REPO||''}" placeholder="例如: my-dns-records">
                  <details class="tutorial-details"><summary>如何获取 GitHub API 信息？</summary><div class="tutorial-content"><ol><li><strong>获取 GitHub Token:</strong><ol type="a"><li>登录 <a href="https://github.com/" target="_blank">GitHub</a>，点击右上角头像，进入 <strong>“Settings”</strong>。</li><li>在左侧菜单中，选择 <strong>“Developer settings”</strong> &rarr; <strong>“Personal access tokens”</strong> &rarr; <strong>“Tokens (classic)”</strong>。</li><li>点击 <strong>“Generate new token”</strong>，并选择 <strong>“Generate new token (classic)”</strong>。</li><li>为令牌添加描述（Note），设置合适的过期时间（Expiration）。</li><li>在 <strong>“Select scopes”</strong> 部分，勾选 <code>repo</code> 权限。</li><li>点击页面底部的 <strong>“Generate token”</strong>，并复制生成的令牌。<strong>注意：令牌仅显示一次，请妥善保管。</strong></li></ol></li><li><strong>获取用户名/组织名 和 仓库名称:</strong><ol type="a"><li><strong>用户名/组织名</strong> 就是您的GitHub个人主页URL中，github.com后面的那部分，或者您组织的主页URL。</li><li><strong>仓库名称</strong> 是您在GitHub上创建的，用来存储IP文件的仓库的名字。如果仓库不存在，系统将在第一次同步时自动为您创建为私有仓库。</li></ol></li></ol></div></details>
              </fieldset>
              <fieldset>
                  <legend>
                      <svg class="icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                      首页显示设置
                  </legend>
                  <div class="form-group">
                      <label class="form-control-inline">
                          <input type="checkbox" id="showSourceOnHomepage" name="showSourceOnHomepage" role="switch">
                          <span>显示来源</span>
                      </label>
                  </div>
              </fieldset>
              <button type="submit">保存设置</button>
          </form>
      </div>
  </div>
  <dialog id="domainModal"><article>
      <header>
          <h3 id="modalTitle"></h3>
          <a href="#close" aria-label="Close" class="close" onclick="window.closeModal('domainModal')">&times;</a>
      </header>
      <form id="domainForm"><input type="hidden" id="domainId"><label for="source_domain">克隆域名</label><input type="text" id="source_domain" placeholder="example-source.com" required><label for="target_domain_prefix">我的域名前缀</label><div class="grid"><input type="text" id="target_domain_prefix" placeholder="subdomain or @" required><span id="zoneNameSuffix" style="line-height:var(--pico-form-element-height);font-weight:700">.your-zone.com</span></div><div class="grid"><div><label for="is_deep_resolve">深度 <span class="tooltip">(?)<span class="tooltip-text">开启后，如果克隆域名是CNAME，系统将递归查找最终的IP地址进行解析。关闭则直接克隆CNAME记录本身。</span></span></label><input type="checkbox" id="is_deep_resolve" role="switch" checked></div><div><label for="ttl">TTL (秒)</label><input type="number" id="ttl" min="60" max="86400" value="60" required></div></div><div class="grid"><div><label for="resolve_record_limit">记录上限</label><input type="number" id="resolve_record_limit" min="1" max="100" value="10" required></div></div><label for="notes">备注 (可选)</label><textarea id="notes" rows="2" placeholder="例如：主力CDN"></textarea><div class="grid"><div><label for="is_single_resolve">单个解析<span class="tooltip">(?)<span class="tooltip-text">开启后，将为每个解析出的IP（根据数量上限）创建单独的子域名。例如 bp1 -> bp1.1, bp1.2 ...</span></span></label><input type="checkbox" id="is_single_resolve" role="switch"></div><div id="single_resolve_limit_container" style="display: none;"><label for="single_resolve_limit">数量上限</label><input type="number" id="single_resolve_limit" min="1" max="50" value="5" required></div></div><div id="single_node_names_container" style="display:none; margin-top: 1rem;"><label><strong>节点名称 (可选)</strong></label></div><footer><button type="button" class="secondary" onclick="window.closeModal('domainModal')">取消</button><button type="submit" id="saveBtn">保存</button></footer></form></article></dialog>
  <dialog id="ipSourceModal"><article>
    <header>
        <h3 id="ipSourceModalTitle"></h3>
        <a href="#close" aria-label="Close" class="close" onclick="window.closeModal('ipSourceModal')">&times;</a>
    </header>
    <form id="ipSourceForm">
      <input type="hidden" id="ipSourceId">
      <div class="grid">
        <label for="ip_source_url">IP源地址</label>
        <button type="button" class="outline" id="probeBtn" style="width:auto;padding:0 1rem;">探测方案</button>
      </div>
      <input type="text" id="ip_source_url" placeholder="https://example.com/ip_list.txt" required>
      <progress id="probeProgress" style="display:none;"></progress>
      <p id="probeResult" style="font-size:0.9em;"></p>

      <div class="form-group">
        <label class="form-control-inline">
            <input type="checkbox" id="is_delayed" name="is_delayed" role="switch">
            <span>延迟获取</span>
        </label>
        <div id="delay-config" style="display: none; margin-top: 0.5rem; border-left: 2px solid rgb(var(--c-border)); padding-left: 1rem;">
          <small>在页面加载后，随机等待一段时间再抓取内容，用于对付动态加载数据的网站。</small>
          <div class="grid" style="margin-top: 0.5rem;">
            <input type="number" id="delay_min" placeholder="最小秒数" min="0">
            <input type="number" id="delay_max" placeholder="最大秒数" min="0">
          </div>
        </div>
      </div>
      
      <label for="github_path">GitHub 文件路径</label>
      <input type="text" id="github_path" placeholder="IP/Cloudflare.txt" required>
      <label for="commit_message">Commit 信息</label>
      <input type="text" id="commit_message" placeholder="Update Cloudflare IPs" required>
      
      <label class="form-control-inline"><input type="checkbox" id="is_node_generation_enabled" name="is_node_generation_enabled" role="switch"><span>生成节点</span></label>
      <div id="node_names_container" style="display: none; margin-top: 1rem;">
        <label for="node_names">节点名称 (每行一个)</label>
        <textarea id="node_names" name="node_names" rows="5" placeholder="节点名称1\n节点名称2\n..."></textarea>
      </div>
      
      <footer>
        <button type="button" class="secondary" onclick="window.closeModal('ipSourceModal')">取消</button>
        <button type="submit" id="saveIpSourceBtn">保存</button>
      </footer>
    </form>
  </article></dialog>
  <dialog id="snippetsModal"><article>
      <header>
        <h3>如何部署 Snippets 反${_k(['代','理'])}？</h3>
        <a href="#close" aria-label="Close" class="close" onclick="window.closeModal('snippetsModal')">&times;</a>
      </header>
      <p>Snippets 是 Cloudflare 提供的一项功能，可以在边缘节点执行轻量级代码，非常适合用于反向${_k(['代','理'])}。</p>
      <ol>
          <li><strong>检查权限</strong>：登录您的 Cloudflare 账户，选择一个已绑定的域名。在左侧菜单中点击 <strong>规则 → Snippets</strong>。如果您能看到创建和管理界面，说明您拥有使用权限。</li>
          <li><strong>备用方案</strong>：如果您的账户没有 Snippets 权限，使用 Workers 部署也能达到相同的效果。请参考 <a href="https://github.com/cmliu/WorkerVless2sub" target="_blank">CMliu</a> 或 <a href="https://github.com/6Kmfi6HP/Sp" target="_blank">6Kmfi6HP</a> 的项目获取 Workers 版本的代码。</li>
          <li><strong>部署 Snippets 代码</strong>：
              <div class="code-block">
                  <div class="code-block-header">
                      <span class="code-block-title">Snippets 代码</span>
                      <button class="secondary outline copy-btn" onclick="window.copyCode(this, 'snippets-code-content')">复制</button>
                  </div>
                  <pre id="snippets-code-content"><code>${snippetsCode.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>
              </div>
          </li>
      </ol>
  </article></dialog>
  <script>${getDashboardScript(domains, ipSources, settings)}</script>`;
}
function getDashboardScript(domains, ipSources, settings) { return `
const _k = (p) => p.join('');
function showNotification(message, type = 'info', duration = 3000) {
    const container = document.getElementById('notifications');
    const toast = document.createElement('div');
    toast.className = \`toast toast-\${type}\`;
    toast.innerHTML = \`<div>\${message}</div>\`;
    container.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.add('hide');
        toast.addEventListener('transitionend', e => {
            if (e.target === toast) toast.remove();
        }, { once: true });
    }, duration);
}
async function apiFetch(url, options = {}) { const res = await fetch(url, { headers: { "Content-Type": "application/json", ...options.headers }, ...options }); if (!res.ok) { const errData = await res.json().catch(() => ({ error: \`HTTP 错误: \${res.status}\` })); if (res.status === 401) { showNotification('会话已过期，请重新登录。', 'error'); setTimeout(() => window.location.href = '/login', 2000); } throw new Error(errData.error); } try { return await res.json(); } catch (e) { return {}; } }
let currentDomains = ${JSON.stringify(domains)};
let currentIpSources = ${JSON.stringify(ipSources)};
let currentSettings = ${JSON.stringify(settings)};
let zoneName = currentSettings.zoneName || '';
let successfulProbeStrategy = null;
let saveProxySettingsTimeout;

const formatBeijingTime = (isoStr) => { if (!isoStr) return '从未'; const d = new Date(isoStr); return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d).replace(/\\//g, '-'); };
const getCurrentBeijingTime = () => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date()).replace(/\\//g, '-');

function renderLiveRecords(records) {
  if (!records || records.length === 0) return '无记录';
  const first = records[0];
  if (records.length === 1) return \`<b>\${first.type}:</b> \${first.content}\`;
  return \`<details class="record-details"><summary><b>\${first.type}:</b> (共 \${records.length} 条)</summary><ul>\${records.map(r => \`<li><b>\${r.type}:</b> \${r.content}</li>\`).join('')}</ul></details>\`;
}

function renderStatus(item) { 
    if (item.needs_push) {
        return \`<span class="status-needs-push">⧖ 待推送</span>\`;
    }
    switch (item.last_sync_status) { 
        case 'success': return \`<span class="status-success">✔ 已同步</span>\`; 
        case 'failed': return \`<span class="status-failed" title="\${item.last_sync_error || '未知错误'}">✖ 获取失败</span>\`; 
        case 'no_change': return \`<span class="status-no_change">✔ 内容一致</span>\`; 
        default: return '○ 待定'; 
    } 
}

function renderDomainCard(domain) {
  let prefix = domain.target_domain;
  if (zoneName && domain.target_domain.endsWith('.' + zoneName)) {
      prefix = domain.target_domain.substring(0, domain.target_domain.length - (zoneName.length + 1));
  } else if (zoneName && domain.target_domain === zoneName) {
      prefix = '@';
  }
  const displayContent = domain.notes ? \`<strong>\${domain.notes}</strong>\` : \`<span class="domain-cell" title="\${domain.target_domain}">\${prefix}</span>\`;
  const isSystem = domain.is_system;
  const systemClass = isSystem ? 'system-domain' : '';
  const sourceDisplay = isSystem ? '系统内置' : domain.source_domain;
  const displayedRecords = domain.displayed_records ? JSON.parse(domain.displayed_records) : [];

  const syncAction = isSystem 
    ? "window.syncSystemDomains(this)"
    : \`window.individualSync(\${domain.id})\`;

  return \`
  <div class="domain-card \${systemClass}" id="domain-card-\${domain.id}">
      <div class="card-col"><strong>我的域名 → 克隆源</strong><span class="domain-cell" title="\${domain.target_domain}" onclick="window.copyToClipboard('\${domain.target_domain}')">\${displayContent}</span><small class="domain-cell" title="\${domain.source_domain}">\${sourceDisplay}</small></div>
      <div class="card-col"><strong>当前解析 <svg class="refresh-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" title="实时查询解析" onclick="window.refreshSingleDomainRecords(\${domain.id})"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg></strong><div id="records-container-\${domain.id}">\${renderLiveRecords(displayedRecords)}</div></div>
      <div class="card-col"><strong>上次同步</strong><div>\${renderStatus(domain)}</div><small>\${formatBeijingTime(domain.last_synced_time)}</small></div>
      <div class="card-actions"><button class="outline" onclick="\${syncAction}">同步</button><button class="outline edit-btn" onclick="window.openModal('domainModal', \${domain.id})">编辑</button><button class="outline delete-btn" onclick="window.deleteDomain(\${domain.id})" \${isSystem ? 'disabled' : ''}>删除</button></div>
  </div>\`;
}
function renderDomainList() { 
  const container = document.getElementById('domain-list-container');
  if (currentDomains.length > 0) {
      container.innerHTML = currentDomains.map(renderDomainCard).join(''); 
  } else {
      container.innerHTML = '<article><p>暂无域名克隆目标，请点击右上角按钮添加。</p></article>';
  }
}

function renderIpSourceCard(source) {
  const fileUrl = \`\${window.location.origin}/\${source.github_path}\`;
  return \`
  <div class="domain-card" id="ip-source-card-\${source.id}">
      <div class="card-col" style="flex-grow: 2;"><strong>GitHub 文件路径</strong><a href="\${fileUrl}" target="_blank" class="domain-cell" onclick="event.stopPropagation();">\${source.github_path}</a><small class="domain-cell" title="\${source.url}">源: \${source.url}</small></div>
      <div class="card-col"><strong>抓取策略</strong><span>\${source.fetch_strategy || '尚未探测'}</span></div>
      <div class="card-col"><strong>上次获取</strong><div>\${renderStatus(source)}</div><small>\${formatBeijingTime(source.last_synced_time)}</small></div>
      <div class="card-actions"><button class="outline" onclick="window.syncSingleIpSource(\${source.id})">立即获取</button><button class="outline edit-btn" onclick="window.openModal('ipSourceModal', \${source.id})">编辑</button><button class="outline delete-btn" onclick="window.deleteIpSource(\${source.id})">删除</button></div>
  </div>\`;
}
function renderIpSourceList() { 
  const container = document.getElementById('ip-source-list-container');
  if (currentIpSources.length > 0) {
      container.innerHTML = currentIpSources.map(renderIpSourceCard).join('');
  } else {
      container.innerHTML = '<article><p>暂无IP源，请点击右上角按钮添加。</p></article>';
  }
}

window.copyToClipboard = (text) => { navigator.clipboard.writeText(text).then(() => { showNotification(\`已复制: \${text}\`, 'success', 3000); }, () => { showNotification(\`复制失败，请检查浏览器权限。\`, 'error'); }); };

window.copyCode = (button, contentId) => {
  const content = document.getElementById(contentId).textContent;
  navigator.clipboard.writeText(content).then(() => {
      button.textContent = '已复制!';
      setTimeout(() => { button.textContent = '复制'; }, 2000);
  }, () => { showNotification('复制失败', 'error'); });
};

function updateSingleNodeNameInputs(limit, names = []) {
  const container = document.getElementById('single_node_names_container');
  container.innerHTML = '<label><strong>节点名称 (可选)</strong></label>';
  for (let i = 0; i < limit; i++) {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'single-node-name-input';
      input.placeholder = \`节点 \${i + 1} 名称\`;
      input.value = names[i] || '';
      input.style.marginBottom = '0.5rem';
      container.appendChild(input);
  }
}

window.openModal = (modalId, id = null) => {
  const modal = document.getElementById(modalId);
  if (modalId === 'domainModal') {
      const form = document.getElementById('domainForm'); form.reset();
      document.getElementById('modalTitle').textContent = id ? '编辑克隆目标' : '添加新克隆目标';
      document.getElementById('zoneNameSuffix').textContent = zoneName ? '.' + zoneName : '(请先保存设置)';
      
      const singleResolveSwitch = document.getElementById('is_single_resolve');
      const limitContainer = document.getElementById('single_resolve_limit_container');
      const limitInput = document.getElementById('single_resolve_limit');
      const namesContainer = document.getElementById('single_node_names_container');
      const recordLimitInput = document.getElementById('resolve_record_limit');

      function toggleSingleResolveUI() {
          const show = singleResolveSwitch.checked;
          limitContainer.style.display = show ? 'block' : 'none';
          namesContainer.style.display = show ? 'block' : 'none';
          if(show) {
              const domain = id ? currentDomains.find(d => d.id === id) : null;
              const names = domain && domain.single_resolve_node_names ? JSON.parse(domain.single_resolve_node_names) : [];
              updateSingleNodeNameInputs(parseInt(limitInput.value, 10), names);
          }
      }
      
      singleResolveSwitch.onchange = toggleSingleResolveUI;
      limitInput.oninput = () => {
          if (singleResolveSwitch.checked) {
              const currentNames = Array.from(document.querySelectorAll('.single-node-name-input')).map(input => input.value);
              updateSingleNodeNameInputs(parseInt(limitInput.value, 10) || 0, currentNames);
          }
      };

      const domain = id ? currentDomains.find(d => d.id === id) : null;
      const isSystem = domain ? !!domain.is_system : false;
      document.getElementById('source_domain').disabled = isSystem;
      document.getElementById('target_domain_prefix').disabled = isSystem;

      if (domain) {
          document.getElementById('domainId').value = domain.id;
          let prefix = domain.target_domain;
          if (zoneName) {
              const suffix = '.' + zoneName;
              if (domain.target_domain === zoneName) { prefix = '@'; }
              else if (domain.target_domain.endsWith(suffix)) { prefix = domain.target_domain.substring(0, domain.target_domain.length - suffix.length); }
          }
          document.getElementById('target_domain_prefix').value = prefix;
          document.getElementById('source_domain').value = domain.source_domain;
          document.getElementById('is_deep_resolve').checked = !!domain.is_deep_resolve;
          document.getElementById('ttl').value = domain.ttl;
          recordLimitInput.value = domain.resolve_record_limit || 10;
          document.getElementById('notes').value = domain.notes;
          singleResolveSwitch.checked = !!domain.is_single_resolve;
          limitInput.value = domain.single_resolve_limit || 5;

          const recordLimit = parseInt(recordLimitInput.value, 10);
          if (parseInt(limitInput.value, 10) > recordLimit) {
              limitInput.value = recordLimit;
          }
          
          const showSingleUI = !!domain.is_single_resolve;
          limitContainer.style.display = showSingleUI ? 'block' : 'none';
          namesContainer.style.display = showSingleUI ? 'block' : 'none';
          if(showSingleUI) {
              const names = domain.single_resolve_node_names ? JSON.parse(domain.single_resolve_node_names) : [];
              updateSingleNodeNameInputs(parseInt(limitInput.value, 10), names);
          }

      } else { 
          document.getElementById('domainId').value = ''; 
          toggleSingleResolveUI();
      }
  } else if (modalId === 'ipSourceModal') {
      const form = document.getElementById('ipSourceForm'); form.reset();
      const nodeGenSwitch = document.getElementById('is_node_generation_enabled');
      const nodeNamesContainer = document.getElementById('node_names_container');
      const isDelayedSwitch = document.getElementById('is_delayed');
      const delayConfig = document.getElementById('delay-config');

      const toggleNodeNamesUI = () => {
          nodeNamesContainer.style.display = nodeGenSwitch.checked ? 'block' : 'none';
      };
      const toggleDelayUI = () => {
          delayConfig.style.display = isDelayedSwitch.checked ? 'block' : 'none';
      };
      
      nodeGenSwitch.onchange = toggleNodeNamesUI;
      isDelayedSwitch.onchange = toggleDelayUI;

      successfulProbeStrategy = null;
      document.getElementById('probeProgress').style.display = 'none';
      document.getElementById('probeResult').textContent = '';
      document.getElementById('saveIpSourceBtn').disabled = true;
      document.getElementById('probeBtn').disabled = false;
      document.getElementById('ipSourceModalTitle').textContent = id ? '编辑IP源' : '添加新IP源';
      if (id) {
          const source = currentIpSources.find(s => s.id === id);
          document.getElementById('ipSourceId').value = source.id;
          document.getElementById('ip_source_url').value = source.url;
          document.getElementById('github_path').value = source.github_path;
          document.getElementById('commit_message').value = source.commit_message;
          nodeGenSwitch.checked = !!source.is_node_generation_enabled;
          document.getElementById('node_names').value = source.node_names || '';
          isDelayedSwitch.checked = !!source.is_delayed;
          document.getElementById('delay_min').value = source.delay_min || 0;
          document.getElementById('delay_max').value = source.delay_max || 0;

          if (source.fetch_strategy) {
              successfulProbeStrategy = source.fetch_strategy;
              document.getElementById('probeResult').textContent = \`已缓存策略: \${successfulProbeStrategy}\`;
              document.getElementById('saveIpSourceBtn').disabled = false;
          }
      } else {
          document.getElementById('ipSourceId').value = '';
          nodeGenSwitch.checked = false;
          document.getElementById('node_names').value = '';
          isDelayedSwitch.checked = false;
          document.getElementById('delay_min').value = 0;
          document.getElementById('delay_max').value = 0;
      }
      toggleNodeNamesUI();
      toggleDelayUI();
  }
  modal.showModal();
};
window.closeModal = (modalId) => { document.getElementById(modalId).close(); };

async function saveDomain() {
  const id = document.getElementById('domainId').value;
  const single_resolve_node_names = Array.from(document.querySelectorAll('.single-node-name-input')).map(input => input.value);
  const payload = { 
      source_domain: document.getElementById('source_domain').value, 
      target_domain_prefix: document.getElementById('target_domain_prefix').value.trim(), 
      is_deep_resolve: document.getElementById('is_deep_resolve').checked, 
      ttl: parseInt(document.getElementById('ttl').value),
      resolve_record_limit: parseInt(document.getElementById('resolve_record_limit').value),
      notes: document.getElementById('notes').value,
      is_single_resolve: document.getElementById('is_single_resolve').checked,
      single_resolve_limit: parseInt(document.getElementById('single_resolve_limit').value),
      single_resolve_node_names: single_resolve_node_names
  };
  const url = id ? '/api/domains/' + id : '/api/domains'; const method = id ? 'PUT' : 'POST';
  try { const result = await apiFetch(url, { method, body: JSON.stringify(payload) }); showNotification(result.message, 'success'); closeModal('domainModal'); await refreshDomains(); } catch (e) { showNotification(\`保存失败: <code>\${e.message}</code>\`, 'error'); }
}
window.deleteDomain = async (id) => { if (!confirm('确定要删除这个目标及其所有DNS记录吗？此操作不可逆转。')) return; try { const result = await apiFetch('/api/domains/' + id, { method: 'DELETE' }); showNotification(result.message, 'success'); await refreshDomains(); } catch (e) { showNotification(\`错误: <code>\${e.message}</code>\`, 'error'); } }

async function refreshDomains() {
  try {
      currentDomains = await apiFetch('/api/domains');
      renderDomainList();
  } catch (e) {
      showNotification(\`更新列表失败: <code>\${e.message}</code>\`, 'error');
  }
}

window.refreshSingleDomainRecords = async (id) => {
    const container = document.getElementById(\`records-container-\${id}\`);
    if (!container) return;
    container.innerHTML = '查询中...';
    try {
        const records = await apiFetch('/api/domains/' + id + '/resolve', { method: 'POST' });
        container.innerHTML = renderLiveRecords(records);
    } catch(e) {
        container.innerHTML = '<span class="status-failed">实时查询失败</span>';
        showNotification(\`查询失败: \${e.message}\`, 'error');
    }
};

async function saveIpSource() {
  const id = document.getElementById('ipSourceId').value;
  const isDelayed = document.getElementById('is_delayed').checked;
  const payload = { 
      url: document.getElementById('ip_source_url').value, 
      github_path: document.getElementById('github_path').value, 
      commit_message: document.getElementById('commit_message').value, 
      fetch_strategy: successfulProbeStrategy,
      is_node_generation_enabled: document.getElementById('is_node_generation_enabled').checked,
      node_names: document.getElementById('node_names').value,
      is_delayed: isDelayed,
      delay_min: isDelayed ? parseInt(document.getElementById('delay_min').value) || 0 : 0,
      delay_max: isDelayed ? parseInt(document.getElementById('delay_max').value) || 0 : 0,
  };
  const apiUrl = id ? \`/api/ip_sources/\${id}\` : '/api/ip_sources';
  const method = id ? 'PUT' : 'POST';
  try { const result = await apiFetch(apiUrl, { method, body: JSON.stringify(payload) }); showNotification(result.message, 'success'); closeModal('ipSourceModal'); await refreshIpSources(); } catch (e) { showNotification(\`保存失败: <code>\${e.message}</code>\`, 'error'); }
}
  window.deleteIpSource = async (id) => { if (!confirm('确定要删除这个IP源及其GitHub文件吗？')) return; try { await apiFetch(\`/api/ip_sources/\${id}\`, { method: 'DELETE' }); showNotification('IP源已删除', 'success'); await refreshIpSources(); } catch(e) { showNotification(\`删除失败: code>\${e.message}</code>\`, 'error'); } }
  async function refreshIpSources() { try { currentIpSources = await apiFetch('/api/ip_sources'); renderIpSourceList(); } catch (e) { showNotification(\`更新IP源列表失败: <code>\${e.message}</code>\`, 'error'); } }

async function handleStreamingRequest(url, btn, logOutputElem, itemId) {
  let hasError = false;
  const allButtons = document.querySelectorAll('button'); allButtons.forEach(b => b.disabled = true); const originalBtnText = btn ? btn.textContent : ''; if (btn) { btn.innerHTML = '处理中...'; btn.setAttribute('aria-busy', 'true'); }
  logOutputElem.style.display = 'block';
  logOutputElem.textContent = '开始任务...\\n';
  try { 
      const response = await fetch(url, { method: 'POST' });
      if (!response.ok || !response.body) {
          try {
            const err = await response.json();
            throw new Error(err.error || \`服务器错误: \${response.status}\`);
          } catch(e) {
            throw new Error(\`服务器错误: \${response.status}\`);
          }
      }
      const reader = response.body.getReader(); 
      const decoder = new TextDecoder();
      while (true) { 
          const { done, value } = await reader.read(); 
          if (done) break; 
          const chunk = decoder.decode(value, { stream: true });
          if(chunk.includes('[FATAL_ERROR]')) hasError = true;
          const lines = chunk.split('\\n\\n').filter(line => line.startsWith('data: ')); 
          for (const line of lines) { logOutputElem.textContent += line.substring(6) + '\\n'; logOutputElem.scrollTop = logOutputElem.scrollHeight; } 
      }
      logOutputElem.textContent += '\\n任务完成，正在更新列表。';
      if(logOutputElem.id === 'logOutput') await refreshDomains();
      if(logOutputElem.id === 'ipLogOutput') await refreshIpSources();
  } catch (e) { 
      hasError = true;
      logOutputElem.textContent += '\\n发生严重错误：\\n' + e.message; 
      showNotification('任务发生错误', 'error');
  } finally { 
      allButtons.forEach(b => b.disabled = false);
      if (btn) { btn.innerHTML = originalBtnText; btn.removeAttribute('aria-busy'); } 
      if(itemId && !hasError && logOutputElem.id === 'logOutput'){
        const card = document.getElementById(\`domain-card-\${itemId}\`);
        if(card){
            const statusCol = card.children[2];
            const statusDiv = statusCol.children[1];
            const timeSmall = statusCol.children[2];
            if(logOutputElem.textContent.includes('内容已更新')){
                 statusDiv.innerHTML = \`<span class="status-success">✔ 已同步</span>\`;
            } else {
                 statusDiv.innerHTML = \`<span class="status-no_change">✔ 内容一致</span>\`;
            }
            timeSmall.textContent = getCurrentBeijingTime();
        }
      }
  }
}

window.syncSystemDomains = (btn) => {
    handleStreamingRequest('/api/domains/sync_system', btn, document.getElementById('logOutput'));
};

window.individualSync = (id) => {
  const btn = document.querySelector(\`#domain-card-\${id} .card-actions button:first-child\`);
  handleStreamingRequest(\`/api/domains/\${id}/sync\`, btn, document.getElementById('logOutput'), id);
};
window.syncSingleIpSource = (id) => {
  const btn = document.querySelector(\`#ip-source-card-\${id} .card-actions button:first-child\`);
  handleStreamingRequest(\`/api/ip_sources/\${id}/sync\`, btn, document.getElementById('ipLogOutput'));
};

  function setupProxyPageListeners() {
      const page = document.getElementById('page-proxy-settings');
      if (!page) return;
      
      page.querySelectorAll('input, select, textarea').forEach(el => {
          el.addEventListener('input', saveProxySettings);
          el.addEventListener('change', saveProxySettings);
      });

      const enableWsProxy = document.getElementById('enableWsReverseProxy');
      const wsConfig = document.getElementById('wsReverseProxyConfig');
      const uuidSpecificRadio = document.getElementById('wsReverseProxyUseSpecificUuid');
      const uuidSpecificContainer = document.getElementById('wsReverseProxySpecificUuidContainer');
      const proxyIpSelector = document.getElementById('proxyIpRegionSelector');

      function toggleWsConfig() {
          wsConfig.style.display = enableWsProxy.checked ? 'block' : 'none';
      }
      function toggleUuidInput() {
          uuidSpecificContainer.style.display = uuidSpecificRadio.checked ? 'block' : 'none';
      }

      enableWsProxy.addEventListener('change', toggleWsConfig);
      page.querySelectorAll('input[name="proxyUuidOption"]').forEach(radio => radio.addEventListener('change', toggleUuidInput));
      
      const subIdCustomRadio = document.getElementById('subUseCustomId');
      const subIdRandomRadio = document.getElementById('subUseRandomId');
      const subIdLengthInput = document.getElementById('subIdLength');
      const subCustomIdInput = document.getElementById('subCustomId');
      const subIdCharsetInput = document.getElementById('subIdCharset');

      function toggleSubIdInputs() {
          const isRandom = subIdRandomRadio.checked;
          subIdLengthInput.disabled = !isRandom;
          subIdCharsetInput.disabled = !isRandom;
          subCustomIdInput.disabled = isRandom;
      }
      page.querySelectorAll('input[name="subIdOption"]').forEach(radio => radio.addEventListener('change', toggleSubIdInputs));
      
      proxyIpSelector.addEventListener('change', (e) => {
          if (e.target.value) {
              const pathInput = document.getElementById('wsReverseProxyPath');
              pathInput.value = \`/?\${_k(['pro','xyip'])}=\${e.target.value}\`;
              pathInput.dispatchEvent(new Event('input'));
          }
      });

      const addSubBtn = document.getElementById('add-sub-btn');
      addSubBtn.addEventListener('click', () => {
          const subs = currentSettings.proxySettings.externalSubscriptions || [];
          subs.push({url: '', enabled: true, filters: ''});
          renderExternalSubscriptions(subs);
          saveProxySettings();
      });
      
      const subsContainer = document.getElementById('external-subs-container');
      subsContainer.addEventListener('change', (e) => {
          if(e.target.classList.contains('ext-sub-url') || e.target.classList.contains('ext-sub-enabled') || e.target.classList.contains('ext-sub-filters')) {
              saveProxySettings();
          }
      });
      subsContainer.addEventListener('click', async (e) => {
          if (e.target.classList.contains('delete-sub-btn')) {
              const index = parseInt(e.target.dataset.index, 10);
              currentSettings.proxySettings.externalSubscriptions.splice(index, 1);
              renderExternalSubscriptions(currentSettings.proxySettings.externalSubscriptions);
              saveProxySettings();
          }
          if (e.target.classList.contains('test-sub-btn')) {
              const index = parseInt(e.target.dataset.index, 10);
              const subItemRow = e.target.closest('.sub-item-row');
              const url = subItemRow.querySelector('.ext-sub-url').value;
              const filters = subItemRow.querySelector('.ext-sub-filters').value;
              const resultEl = document.getElementById(\`ext-sub-result-\${index}\`);
              
              if (!url) {
                  resultEl.textContent = 'URL为空';
                  return;
              }

              e.target.disabled = true;
              e.target.innerHTML = '检测中...';
              resultEl.textContent = '';

              try {
                  const result = await apiFetch(_k(['/api/pr','oxy/test_sub','script','ion']), {
                      method: 'POST',
                      body: JSON.stringify({ url, filters })
                  });
                  if (result.success) {
                      resultEl.textContent = \`✔ 成功 (\${result.nodeCount}个节点)\`;
                      resultEl.style.color = 'var(--status-success-color)';
                  } else {
                      resultEl.textContent = \`✖ 失败\`;
                      resultEl.style.color = 'var(--status-failed-color)';
                      showNotification(result.error, 'error');
                  }
              } catch (err) {
                  resultEl.textContent = \`✖ 失败\`;
                  resultEl.style.color = 'var(--status-failed-color)';
                  showNotification(err.message, 'error');
              } finally {
                  e.target.disabled = false;
                  e.target.textContent = '检测';
              }
          }
      });
      
      const filterModeRadios = document.querySelectorAll('input[name="filterMode"]');
      filterModeRadios.forEach(radio => radio.addEventListener('change', () => {
          renderExternalSubscriptions(currentSettings.proxySettings.externalSubscriptions);
          saveProxySettings();
      }));

      toggleWsConfig();
      toggleUuidInput();
      toggleSubIdInputs();
      setupSubscriptionButtons();
  }
  
  function renderExternalSubscriptions(subs = []) {
      const container = document.getElementById('external-subs-container');
      const filterMode = document.querySelector('input[name="filterMode"]:checked')?.value || 'none';
      
      document.getElementById('global-filters-container').style.display = filterMode === 'global' ? 'block' : 'none';

      container.innerHTML = (subs || []).map((sub, index) => {
          return \`
              <div class="sub-item-row">
                  <input type="text" class="ext-sub-url" placeholder="${_k(['订','阅'])}地址" value="\${sub.url || ''}">
                  <div class="ext-sub-filters-container" \${filterMode !== 'individual' ? 'style="display:none;"' : ''}>
                      <textarea class="ext-sub-filters" rows="2" placeholder="过滤规则 (每行一条，例如 #M:名称=新名称)">\${sub.filters || ''}</textarea>
                  </div>
                  <div class="sub-item-controls">
                      <label class="form-control-inline">
                          <input type="checkbox" class="ext-sub-enabled" \${sub.enabled ? 'checked' : ''}> <span>启用</span>
                      </label>
                      <small class="ext-sub-result" id="ext-sub-result-\${index}"></small>
                      <button class="secondary test-sub-btn" data-index="\${index}">检测</button>
                      <button class="contrast delete-sub-btn" data-index="\${index}">删除</button>
                  </div>
              </div>
          \`;
      }).join('');
  }
  
  function populateProxySettingsForm() {
      const ps = currentSettings.proxySettings || {};
      document.getElementById('enableWsReverseProxy').checked = ps.enableWsReverseProxy || false;
      document.getElementById('wsReverseProxyUrl').value = ps.wsReverseProxyUrl || '';
      document.getElementById('wsReverseProxyPath').value = ps.wsReverseProxyPath || '/';
      document.querySelector('input[name="proxyUuidOption"][value="random"]').checked = ps.wsReverseProxyUseRandomUuid === undefined ? true : ps.wsReverseProxyUseRandomUuid;
      document.getElementById('wsReverseProxyUseSpecificUuid').checked = !ps.wsReverseProxyUseRandomUuid;
      document.getElementById('wsReverseProxyUuidValue').value = ps.wsReverseProxySpecificUuid || '';
      document.getElementById('sublinkWorkerUrl').value = ps.sublinkWorkerUrl;
      document.getElementById('publicSubscriptionToggle').checked = ps.publicSubscription || false;
      document.getElementById('subUseRandomId').checked = ps.subUseRandomId === undefined ? true : ps.subUseRandomId;
      document.getElementById('subUseCustomId').checked = ! (ps.subUseRandomId === undefined ? true : ps.subUseRandomId);
      document.getElementById('subIdLength').value = ps.subIdLength || 12;
      document.getElementById('subCustomId').value = ps.subCustomId || '';
      document.getElementById('subIdCharset').value = ps.subIdCharset || 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      document.getElementById('customNodes').value = ps.customNodes || '';
      document.getElementById(\`filterMode\${ps.filterMode ? ps.filterMode.charAt(0).toUpperCase() + ps.filterMode.slice(1) : 'None'}\`).checked = true;
      document.getElementById('globalFilters').value = ps.globalFilters || '';
      
      renderExternalSubscriptions(ps.externalSubscriptions);
  }

  async function saveProxySettings() {
      clearTimeout(saveProxySettingsTimeout);
      saveProxySettingsTimeout = setTimeout(async () => {
          const externalSubscriptions = [];
          document.querySelectorAll('#external-subs-container .sub-item-row').forEach(el => {
              const url = el.querySelector('.ext-sub-url').value;
              const enabled = el.querySelector('.ext-sub-enabled').checked;
              const filters = el.querySelector('.ext-sub-filters').value;
              externalSubscriptions.push({ url, enabled, filters });
          });

          const proxySettings = {
              enableWsReverseProxy: document.getElementById('enableWsReverseProxy').checked,
              wsReverseProxyUrl: document.getElementById('wsReverseProxyUrl').value,
              wsReverseProxyPath: document.getElementById('wsReverseProxyPath').value,
              wsReverseProxyUseRandomUuid: document.querySelector('input[name="proxyUuidOption"][value="random"]').checked,
              wsReverseProxySpecificUuid: document.getElementById('wsReverseProxyUuidValue').value,
              useSelfUrlForSni: false,
              useProxyUrlForSni: true,
              sublinkWorkerUrl: document.getElementById('sublinkWorkerUrl').value,
              publicSubscription: document.getElementById('publicSubscriptionToggle').checked,
              subUseRandomId: document.getElementById('subUseRandomId').checked,
              subIdLength: parseInt(document.getElementById('subIdLength').value, 10),
              subCustomId: document.getElementById('subCustomId').value,
              subIdCharset: document.getElementById('subIdCharset').value,
              externalSubscriptions: externalSubscriptions,
              customNodes: document.getElementById('customNodes').value,
              filterMode: document.querySelector('input[name="filterMode"]:checked').value,
              globalFilters: document.getElementById('globalFilters').value,
              showSourceOnHomepage: document.getElementById('showSourceOnHomepage').checked
          };
          
          const oldProxySettings = currentSettings.proxySettings;
          currentSettings.proxySettings = proxySettings;

          try {
              const fullSettings = { ...currentSettings, proxySettings };
              await apiFetch('/api/settings', { method: 'POST', body: JSON.stringify(fullSettings) });
              
              showNotification('${_k(['代','理'])}设置已自动保存', 'success', 2000);

              proxySettings.externalSubscriptions.forEach((sub, index) => {
                  const oldSub = oldProxySettings.externalSubscriptions ? oldProxySettings.externalSubscriptions[index] : null;
                  if (oldSub && !oldSub.enabled && sub.enabled && sub.url) {
                      document.querySelector(\`#ext-sub-result-\${index} ~ .test-sub-btn\`).click();
                  }
              });

          } catch(e) {
              showNotification(\`${_k(['代','理'])}设置保存失败: \${e.message}\`, 'error');
          }
      }, 500);
  }
  
  function setupSubscriptionButtons() {
      function generateAndCopySubLink(subType, button) {
          const ps = currentSettings.proxySettings || {};
          let subId;
          if (ps.subUseRandomId) {
              const len = ps.subIdLength || 12;
              const charset = ps.subIdCharset || 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
              if (!len || !charset) { showNotification("请先配置随机ID长度和字符集", "error"); return; }
              subId = Array.from({length: len}, () => charset.charAt(Math.floor(Math.random() * charset.length))).join('');
          } else {
              subId = ps.subCustomId || '';
              if (!subId) { showNotification("请先配置自定义ID", "error"); return; }
          }
          const finalUrl = \`\${window.location.origin}/\${subId}/\${subType}\`;
          
          navigator.clipboard.writeText(finalUrl).then(() => {
              if (button) {
                  const originalText = button.textContent;
                  button.textContent = '复制成功!';
                  setTimeout(() => { button.textContent = originalText; }, 3000);
              } else {
                  showToast(\`\${subType.charAt(0).toUpperCase() + subType.slice(1)} ${_k(['订','阅'])}已复制\`);
              }
          }).catch(err => {
              if (button) {
                  const originalText = button.textContent;
                  button.textContent = '复制失败!';
                  setTimeout(() => { button.textContent = originalText; }, 3000);
              } else {
                  showToast('复制失败!');
              }
          });
      }
      
      document.getElementById('copyXraySub')?.addEventListener('click', (e) => generateAndCopySubLink('xray', e.target));
      document.getElementById('copyClashSub')?.addEventListener('click', (e) => generateAndCopySubLink('clash', e.target));
      document.getElementById('copySingboxSub')?.addEventListener('click', (e) => generateAndCopySubLink('singbox', e.target));
      document.getElementById('copySurgeSub')?.addEventListener('click', (e) => generateAndCopySubLink('surge', e.target));
      
      document.querySelectorAll('#sub-buttons-desktop button, #sub-buttons-mobile button').forEach(btn => {
          btn.addEventListener('click', (e) => {
              generateAndCopySubLink(e.target.dataset.subType);
          });
      });
  }

async function saveSettings(event) {
  event.preventDefault();
  const form = event.target;
  const btn = form.querySelector('button[type="submit"]');
  if (!btn) return;

  const originalBtnText = btn.textContent;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.textContent = '正在保存...';
  
  const oldThreeNetworkSource = currentSettings.THREE_NETWORK_SOURCE;
  const newThreeNetworkSource = document.getElementById('threeNetworkSource').value;

  const proxySettings = currentSettings.proxySettings || {};
  proxySettings.showSourceOnHomepage = document.getElementById('showSourceOnHomepage').checked;

  const settingsToSave = {
      CF_API_TOKEN: document.getElementById('cfToken').value,
      CF_ZONE_ID: document.getElementById('cfZoneId').value,
      THREE_NETWORK_SOURCE: newThreeNetworkSource,
      GITHUB_TOKEN: document.getElementById('githubToken').value,
      GITHUB_OWNER: document.getElementById('githubOwner').value,
      GITHUB_REPO: document.getElementById('githubRepo').value,
      proxySettings: proxySettings
  };
  try {
      const result = await apiFetch('/api/settings', { method: 'POST', body: JSON.stringify(settingsToSave) });
      showNotification(result.message || '设置已保存！', 'success');
      btn.textContent = '保存成功!';
      
      if (oldThreeNetworkSource !== newThreeNetworkSource) {
          showNotification('三网优选源已更改，正在为您同步系统域名...', 'info');
          window.syncSystemDomains();
      }

      const newSettings = await apiFetch('/api/settings');
      currentSettings = {...currentSettings, ...newSettings };
      zoneName = currentSettings.zoneName || '';
      const githubSettingsComplete = currentSettings.GITHUB_TOKEN && currentSettings.GITHUB_OWNER && currentSettings.GITHUB_REPO;
      document.getElementById('addDomainBtn').disabled = !zoneName;
      document.getElementById('addIpSourceBtn').disabled = !githubSettingsComplete;
      await refreshDomains();
  } catch (e) {
      showNotification(\`保存失败: <br><code>\${e.message}</code>\`, 'error', 10000);
      btn.textContent = '保存失败';
  } finally {
      setTimeout(() => {
          btn.disabled = false;
          btn.removeAttribute('aria-busy');
          btn.textContent = originalBtnText;
      }, 2000);
  }
}

function updateCountdown() {
    const countdownEl = document.getElementById('push-countdown');
    if (!countdownEl) return;

    const now = new Date();
    const minutes = now.getUTCMinutes();
    const seconds = now.getUTCSeconds();

    let minutesToNextPush = 20 - (minutes % 20);
    if (minutes % 20 === 0 && seconds < 5) { // Grace period for the task to start
        countdownEl.textContent = '正在推送中...';
        return;
    }
    if (minutesToNextPush === 20) minutesToNextPush = 0; // It's exactly on the push minute but after the grace period

    const secondsToNextPush = (minutesToNextPush * 60) - seconds;
    
    const displayMinutes = Math.floor(secondsToNextPush / 60);
    const displaySeconds = secondsToNextPush % 60;
    
    countdownEl.textContent = \`\${String(displayMinutes).padStart(2, '0')}:\${String(displaySeconds).padStart(2, '0')}\`;
}

document.addEventListener('DOMContentLoaded', async () => {
    let isDark = false;
    const themeToggle = document.getElementById('theme-toggle');
    const moonIcon = \`<svg class="icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>\`;
    const sunIcon = \`<svg class="icon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>\`;

    function updateTheme() {
        if(themeToggle) themeToggle.innerHTML = isDark ? sunIcon : moonIcon;
        document.documentElement.classList.toggle('dark', isDark);
    }
    
    if (themeToggle) {
        themeToggle.addEventListener('click', () => {
            isDark = !isDark;
            updateTheme();
        });
    }

    function setInitialMode() {
        const now = new Date();
        const utcHour = now.getUTCHours();
        const beijingHour = (utcHour + 8) % 24;
        isDark = !(beijingHour >= 7 && beijingHour < 19);
        updateTheme();
    }
    setInitialMode();

  try {
      currentSettings = await apiFetch('/api/settings');
      zoneName = currentSettings.zoneName || '';
      if (currentSettings.proxySettings) {
        document.getElementById('showSourceOnHomepage').checked = currentSettings.proxySettings.showSourceOnHomepage || false;
      }
  } catch(e) {
      showNotification('加载设置失败', 'error');
  }

  renderDomainList();
  renderIpSourceList();
  populateProxySettingsForm();
  
  const navLinks = document.querySelectorAll('.nav-link');
  const pages = document.querySelectorAll('.page');
  navLinks.forEach(link => {
      link.addEventListener('click', (e) => {
          e.preventDefault();
          const targetId = link.dataset.target;
          pages.forEach(page => page.classList.remove('active'));
          document.getElementById(targetId).classList.add('active');
          navLinks.forEach(l => l.classList.remove('active'));
          link.classList.add('active');
          window.scrollTo(0, 0);
      });
  });
  
  setupProxyPageListeners();

  document.getElementById('settingsForm').addEventListener('submit', saveSettings);
  document.getElementById('addDomainBtn').addEventListener('click', () => openModal('domainModal'));
  document.getElementById('manualSyncBtn').addEventListener('click', async (e) => {
    const btn = e.target;
    const logOutput = document.getElementById('logOutput');
    const allButtons = document.querySelectorAll('button');
    
    allButtons.forEach(b => b.disabled = true);
    const originalBtnText = btn.textContent;
    btn.innerHTML = '处理中...';
    btn.setAttribute('aria-busy', 'true');
    logOutput.style.display = 'block';
    logOutput.textContent = '开始批量同步所有域名...\\n';
    
    try {
      // 先同步系统域名
      logOutput.textContent += '正在同步系统域名...\\n';
      await fetchWithProgress('/api/domains/sync_system', logOutput, '系统域名同步');
      
      // 获取所有非系统域名
      const nonSystemDomains = currentDomains.filter(d => !d.is_system && d.is_enabled);
      
      if (nonSystemDomains.length === 0) {
        logOutput.textContent += '\\n没有需要同步的非系统域名。';
      } else {
        logOutput.textContent += \`\\n发现 \${nonSystemDomains.length} 个非系统域名需要同步。\\n\\n\`;
        
        // 按顺序同步，每个域名间隔3秒
        for (let i = 0; i < nonSystemDomains.length; i++) {
          const domain = nonSystemDomains[i];
          logOutput.textContent += \`\\n正在同步域名 (\${i + 1}/\${nonSystemDomains.length}): \${domain.target_domain}\\n\`;
          logOutput.scrollTop = logOutput.scrollHeight;
          
          try {
            // 使用单个域名的同步API
            await fetchWithProgress(\`/api/domains/\${domain.id}/sync\`, logOutput, domain.target_domain);
          } catch(e) {
            logOutput.textContent += \`\\n❌ 处理域名 \${domain.target_domain} 失败: \${e.message}\\n\`;
          }
          
          // 如果不是最后一个域名，等待3秒
          if (i < nonSystemDomains.length - 1) {
            logOutput.textContent += '\\n等待1秒后继续下一个域名...\\n';
            logOutput.scrollTop = logOutput.scrollHeight;
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      }
      
      logOutput.textContent += '\\n所有域名同步任务执行完毕。';
      await refreshDomains();
      
    } catch (e) {
      logOutput.textContent += \`\\n❌ 批量同步失败: \${e.message}\\n\`;
      showNotification('批量同步发生错误', 'error');
    } finally {
      allButtons.forEach(b => b.disabled = false);
      btn.innerHTML = originalBtnText;
      btn.removeAttribute('aria-busy');
    }
  });
  
  async function fetchWithProgress(apiUrl, logOutputElem, context = '') {
    try {
      const response = await fetch(apiUrl, { 
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });
      
      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: \`HTTP \${response.status}\` }));
        throw new Error(err.error || '请求失败');
      }
      
      // 对于流式响应，使用reader读取
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        // 处理SSE格式的数据
        const lines = chunk.split('\\n\\n').filter(line => line.startsWith('data: '));
        for (const line of lines) {
          const message = line.substring(6); // 去掉"data: "
          logOutputElem.textContent += \`\${message}\\n\`;
          logOutputElem.scrollTop = logOutputElem.scrollHeight;
        }
      }
      
      logOutputElem.textContent += \`\\n✔ \${context} 同步完成\\n\`;
      logOutputElem.scrollTop = logOutputElem.scrollHeight;
      
    } catch (error) {
      logOutputElem.textContent += \`\\n❌ \${context} 同步失败: \${error.message}\\n\`;
      logOutputElem.scrollTop = logOutputElem.scrollHeight;
      throw error;
    }
  }

  // 修改单个同步按钮的事件处理，使用新的fetchWithProgress函数
  window.individualSync = async (id) => {
    const domain = currentDomains.find(d => d.id === id);
    if (!domain) return;
    
    const btn = document.querySelector(\`#domain-card-\${id} .card-actions button:first-child\`);
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = '同步中...';
    
    // 创建临时日志显示区域
    const logOutput = document.getElementById('logOutput');
    logOutput.style.display = 'block';
    logOutput.textContent = \`开始同步域名: \${domain.target_domain}\\n\`;
    logOutput.scrollTop = logOutput.scrollHeight;
    
    try {
      await fetchWithProgress(\`/api/domains/\${id}/sync\`, logOutput, domain.target_domain);
      await refreshDomains();
    } catch (e) {
      logOutput.textContent += \`\\n❌ 同步失败: \${e.message}\\n\`;
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalText;
    }
  };

  // 辅助函数：调用单个域名的同步API并等待完成
  async function fetchAndWait(apiUrl, logOutputElem) {
    return new Promise((resolve, reject) => {
      const eventSource = new EventSource(apiUrl);
      let hasError = false;
      
      eventSource.onmessage = (event) => {
        const message = event.data;
        logOutputElem.textContent += message + '\\n';
        logOutputElem.scrollTop = logOutputElem.scrollHeight;
        
        // 检测是否完成
        if (message.includes('任务完成') || message.includes('内容已更新') || message.includes('内容一致')) {
          eventSource.close();
          if (!hasError) {
            resolve();
          }
        }
      };
      
      eventSource.onerror = (error) => {
        hasError = true;
        logOutputElem.textContent += \`\\n❌ 同步失败: \${error}\\n\`;
        eventSource.close();
        reject(new Error('同步失败'));
      };
      
      // 设置超时
      setTimeout(() => {
        if (!hasError) {
          logOutputElem.textContent += '\\n⚠️ 同步超时，继续下一个域名\\n';
          eventSource.close();
          resolve();
        }
      }, 60000); // 60秒超时
    });
  }
  document.getElementById('domainForm').addEventListener('submit', (e) => { e.preventDefault(); saveDomain(); });
  
  const singleResolveSwitch = document.getElementById('is_single_resolve');
  const recordLimitInput = document.getElementById('resolve_record_limit');
  const singleResolveLimitInput = document.getElementById('single_resolve_limit');
  
  recordLimitInput.addEventListener('input', () => {
      const recordLimit = parseInt(recordLimitInput.value, 10);
      const singleLimit = parseInt(singleResolveLimitInput.value, 10);
      if (!isNaN(recordLimit) && singleLimit > recordLimit) {
          singleResolveLimitInput.value = recordLimit;
          if (singleResolveSwitch.checked) {
               const currentNames = Array.from(document.querySelectorAll('.single-node-name-input')).map(input => input.value);
               updateSingleNodeNameInputs(recordLimit, currentNames);
          }
      }
  });

  singleResolveSwitch.addEventListener('change', () => {
      const show = singleResolveSwitch.checked;
      document.getElementById('single_resolve_limit_container').style.display = show ? 'block' : 'none';
      document.getElementById('single_node_names_container').style.display = show ? 'block' : 'none';
      if(show) { updateSingleNodeNameInputs(parseInt(singleResolveLimitInput.value, 10)); }
  });
  singleResolveLimitInput.addEventListener('input', () => {
      if(singleResolveSwitch.checked) {
          const currentNames = Array.from(document.querySelectorAll('.single-node-name-input')).map(input => input.value);
          updateSingleNodeNameInputs(parseInt(singleResolveLimitInput.value, 10) || 0, currentNames);
      }
  });

  document.getElementById('addIpSourceBtn').addEventListener('click', () => openModal('ipSourceModal'));
  document.getElementById('manualSyncIpSourcesBtn').addEventListener('click', (e) => handleStreamingRequest('/api/ip_sources/sync_all', e.target, document.getElementById('ipLogOutput')));
  document.getElementById('ipSourceForm').addEventListener('submit', (e) => { e.preventDefault(); saveIpSource(); });

  document.getElementById('probeBtn').addEventListener('click', async (e) => {
      const url = document.getElementById('ip_source_url').value;
      if (!url) { showNotification('请输入IP源地址', 'warning'); return; }
      
      const btn = e.target;
      const progress = document.getElementById('probeProgress');
      const resultElem = document.getElementById('probeResult');
      const saveBtn = document.getElementById('saveIpSourceBtn');

      btn.disabled = true;
      saveBtn.disabled = true;
      progress.style.display = 'block';
      progress.removeAttribute('value');
      resultElem.textContent = '正在探测...';
      successfulProbeStrategy = null;

      try {
          const isDelayed = document.getElementById('is_delayed').checked;
          const payload = { 
              url,
              is_delayed: isDelayed,
              delay_min: isDelayed ? parseInt(document.getElementById('delay_min').value) || 0 : 0,
              delay_max: isDelayed ? parseInt(document.getElementById('delay_max').value) || 0 : 0,
          };
          const result = await apiFetch('/api/ip_sources/probe', { method: 'POST', body: JSON.stringify(payload) });
          progress.setAttribute('value', '100');
          resultElem.textContent = \`探测成功！策略: \${result.strategy} | 发现 \${result.ipCount} 个IP\`;
          successfulProbeStrategy = result.strategy;
          saveBtn.disabled = false;
      } catch (error) {
          progress.style.display = 'none';
          resultElem.textContent = \`探测失败: \${error.message}\`;
          showNotification(\`探测失败: \${error.message}\`, 'error');
      } finally {
          btn.disabled = false;
      }
  });
  
  updateCountdown();
  setInterval(updateCountdown, 1000);
});
`;}

async function apiGetIpSources(db) {
  const { results } = await db.prepare("SELECT id, url, github_path, commit_message, fetch_strategy, strftime('%Y-%m-%dT%H:%M:%SZ', last_synced_time) as last_synced_time, last_sync_status, last_sync_error, is_enabled, is_node_generation_enabled, node_names, needs_push, is_delayed, delay_min, delay_max FROM ip_sources ORDER BY github_path").all();
  const decodedResults = results.map(s => ({...s, url: _du(s.url)}));
  return jsonResponse(decodedResults);
}

async function apiAddIpSource(request, db) {
  let { url, github_path, commit_message, fetch_strategy, is_node_generation_enabled, node_names, is_delayed, delay_min, delay_max } = await request.json();
  if (!url || !github_path || !commit_message || !fetch_strategy) {
      return jsonResponse({ error: '缺少必填字段或尚未成功探测获取策略。' }, 400);
  }
  try {
      url = _e(url);
      await db.prepare("INSERT INTO ip_sources (url, github_path, commit_message, fetch_strategy, is_node_generation_enabled, node_names, is_delayed, delay_min, delay_max) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(url, github_path, commit_message, fetch_strategy, is_node_generation_enabled ? 1 : 0, node_names, is_delayed ? 1 : 0, delay_min || 0, delay_max || 0).run();
      return jsonResponse({ success: true, message: 'IP源添加成功。' });
  } catch (e) {
      if (e.message.includes('UNIQUE constraint failed')) return jsonResponse({ error: '该URL或GitHub文件路径已存在。' }, 409);
      throw e;
  }
}

async function apiUpdateIpSource(request, db, id) {
  let { url, github_path, commit_message, fetch_strategy, is_node_generation_enabled, node_names, is_delayed, delay_min, delay_max } = await request.json();
  if (!url || !github_path || !commit_message || !fetch_strategy) {
      return jsonResponse({ error: '缺少必填字段或尚未成功探测获取策略。' }, 400);
  }
  try {
      url = _e(url);
      await db.prepare("UPDATE ip_sources SET url=?, github_path=?, commit_message=?, fetch_strategy=?, is_node_generation_enabled=?, node_names=?, is_delayed=?, delay_min=?, delay_max=? WHERE id=?")
          .bind(url, github_path, commit_message, fetch_strategy, is_node_generation_enabled ? 1 : 0, node_names, is_delayed ? 1 : 0, delay_min || 0, delay_max || 0, id).run();
      return jsonResponse({ success: true, message: 'IP源更新成功。' });
  } catch (e) {
      if (e.message.includes('UNIQUE constraint failed')) return jsonResponse({ error: '该URL或GitHub文件路径已存在。' }, 409);
      throw e;
  }
}

async function apiDeleteIpSource(db, id) {
  const githubSettings = await getGitHubSettings(db);
  const sourceToDelete = await db.prepare('SELECT github_path FROM ip_sources WHERE id = ?').bind(id).first();

  if (sourceToDelete && githubSettings.token && githubSettings.owner && githubSettings.repo) {
      const { token, owner, repo } = githubSettings;
      const path = sourceToDelete.github_path;
      const apiUrl = `${_d([104,116,116,112,115,58,47,47,97,112,105,46,103,105,116,104,117,98,46,99,111,109,47,114,101,112,111,115,47])}${owner}/${repo}/contents/${path}`;
      
      try {
          const fileResponse = await githubApiRequest(apiUrl, token);
          const fileData = await fileResponse.json();
          const sha = fileData.sha;

          const deleteBody = JSON.stringify({
              message: `Delete file: ${path}`,
              sha: sha
          });

          await githubApiRequest(apiUrl, token, { method: 'DELETE', body: deleteBody });
      } catch (e) {
          if (!e.message.includes('404')) {
              console.error(`删除GitHub文件失败 (但将继续删除数据库条目): ${e.message}`);
          }
      }
  }

  await db.prepare('DELETE FROM ip_sources WHERE id = ?').bind(id).run();
  return jsonResponse({ success: true, message: "IP源及其关联的GitHub文件已删除。" });
}


const ipv4Regex = /\b((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g;
const ipv6Regex = /(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))/gi;

const FETCH_STRATEGIES = {
  [_k(['direct','_regex'])]: async (url, options) => {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error(`HTTP error ${res.status}`);
      const text = await res.text();
      
      const lines = text.split('\n');
      const ips = new Set();
      
      const strictIPv4Regex = /^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
      const strictIPv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/i;

      for (const line of lines) {
          const trimmedLine = line.trim();
          if (strictIPv4Regex.test(trimmedLine) || strictIPv6Regex.test(trimmedLine)) {
              ips.add(trimmedLine);
          }
      }
      
      return Array.from(ips);
  },
  [_k(['phantomjs_cloud','_random_delay'])]: async (url, options) => {
      let waitCondition;
      const uouinUrl = _du(_e(_d([104,116,116,112,115,58,47,47,97,112,105,46,117,111,117,105,110,46,99,111,109,47,99,108,111,117,100,102,108,97,114,101,46,104,116,109,108])));

      if (url === uouinUrl) {
          waitCondition = { textExists: "CloudFlare优选IP仅对CDN节点IP进行优选" };
          console.log(`Smart wait: waiting for specific text for ${url}`);
      } else {
          const beijingTime = new Date(new Date().getTime() + 8 * 60 * 60 * 1000);
          const beijingDateString = beijingTime.toISOString().split('T')[0].replace(/-/g, '/');
          waitCondition = { textExists: beijingDateString };
          console.log(`Smart wait: waiting for today's date '${beijingDateString}' to appear.`);
      }

      const body = { 
          url, 
          renderType: 'html',
          requestSettings: {
              doneWhen: [waitCondition],
              doneWhenTimeout: 20000
          }
      };
      
      const res = await fetch(_d([104,116,116,112,115,58,47,47,80,104,97,110,116,111,109,74,115,67,108,111,117,100,46,99,111,109,47,97,112,105,47,98,114,111,119,115,101,114,47,118,50,47,97,45,100,101,109,111,45,107,101,121,45,119,105,116,104,45,108,111,119,45,113,117,111,116,97,45,112,101,114,45,105,112,45,97,100,100,114,101,115,115,47]), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
      });
      if (!res.ok) {
          const errorText = await res.text();
          console.error("PhantomJsCloud Error Response:", errorText);
          throw new Error(`PhantomJsCloud (Smart Wait) API error ${res.status}`);
      }
      const text = await res.text();
      const ipv4s = text.match(ipv4Regex) || [];
      const ipv6s = text.match(ipv6Regex) || [];
      return [...new Set([...ipv4s, ...ipv6s])];
  },
  [_k(['phantomjs_cloud','_interactive'])]: async (url, options) => {
      const pageLoadScript = [
          { "scroll": { "selector": "body" } },
          { "wait": 3000 },
          { "scroll": { "x": 0, "y": 0 } },
          { "wait": 2000 }
      ];
      const res = await fetch(_d([104,116,116,112,115,58,47,47,80,104,97,110,116,111,109,74,115,67,108,111,117,100,46,99,111,109,47,97,112,105,47,98,114,111,119,115,101,114,47,118,50,47,97,45,100,101,109,111,45,107,101,121,45,119,105,116,104,45,108,111,119,45,113,117,111,116,97,45,112,101,114,45,105,112,45,97,100,100,114,101,115,115,47]), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
              url,
              renderType: 'html',
              scripts: {
                  load: pageLoadScript
              }
          })
      });
      if (!res.ok) throw new Error(`PhantomJsCloud (Interactive) API error ${res.status}`);
      const text = await res.text();
      const ipv4s = text.match(ipv4Regex) || [];
      const ipv6s = text.match(ipv6Regex) || [];
      return [...new Set([...ipv4s, ...ipv6s])];
  },
};

const SECOND_TIER_PROXIES = [
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://cors-anywhere.herokuapp.com/${url}`,
  (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
  (url) => `https://thingproxy.freeboard.io/fetch/${url}`,
  (url) => `https://cors.eu.org/${url}`,
  (url) => `https://proxy.cors.sh/${url}`,
  (url) => `https://api.crss.dev/api/get?url=${encodeURIComponent(url)}`,
  (url) => `https://web-production-532d.up.railway.app/${url}`
];

const SECOND_TIER_STRATEGIES = SECOND_TIER_PROXIES.map((proxyFn, index) => {
    const name = `proxy_${index + 1}`;
    return {
        [name]: async (url, options) => {
            const res = await fetch(proxyFn(url), { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (!res.ok) throw new Error(`Proxy ${index + 1} error ${res.status}`);
            const text = await res.text();
            const ipv4s = text.match(ipv4Regex) || [];
            const ipv6s = text.match(ipv6Regex) || [];
            return [...new Set([...ipv4s, ...ipv6s])];
        }
    };
}).reduce((acc, curr) => ({...acc, ...curr}), {});

const ALL_STRATEGIES = {...FETCH_STRATEGIES, ...SECOND_TIER_STRATEGIES};

async function probeSourceUrl(url, source) {
    if (!url) {
        throw new Error('URL is required for probing.');
    }
    
    if (source && source.is_delayed) {
      try {
        const ips = await ALL_STRATEGIES['phantomjs_cloud_random_delay'](url, {});
        if (ips && ips.length > 0) {
          // 处理IPv6地址格式以便显示
          const processedIps = ips.map(ip => {
            const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/i;
            if (ipv6Regex.test(ip.trim())) {
              return `[${ip.trim()}]`;
            }
            return ip.trim();
          });
          return { success: true, strategy: 'phantomjs_cloud_random_delay', ipCount: ips.length, sampleIps: processedIps.slice(0, 5) };
        }
      } catch (e) {
        console.log(`Forced delay strategy failed for URL '${url}': ${e.message}`);
        throw new Error('配置的延迟获取策略执行失败。请检查目标网站或稍后再试。');
      }
      throw new Error('配置的延迟获取策略未能提取到IP。');
    }
  
    const primaryStrategies = [_k(['direct','_regex']), _k(['phantomjs_cloud','_interactive'])];
    for (const strategyName of primaryStrategies) {
        try {
            const ips = await ALL_STRATEGIES[strategyName](url, {});
            if (ips && ips.length > 0) {
              // 处理IPv6地址格式以便显示
              const processedIps = ips.map(ip => {
                const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/i;
                if (ipv6Regex.test(ip.trim())) {
                  return `[${ip.trim()}]`;
                }
                return ip.trim();
              });
              return { success: true, strategy: strategyName, ipCount: ips.length, sampleIps: processedIps.slice(0, 5) };
            }
        } catch (e) { console.log(`Tier 1 strategy '${strategyName}' failed for URL '${url}': ${e.message}`); }
    }
  
    for (const [strategyName, strategyFn] of Object.entries(SECOND_TIER_STRATEGIES)) {
        try {
            const ips = await strategyFn(url, {});
            if (ips && ips.length > 0) {
              // 处理IPv6地址格式以便显示
              const processedIps = ips.map(ip => {
                const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/i;
                if (ipv6Regex.test(ip.trim())) {
                  return `[${ip.trim()}]`;
                }
                return ip.trim();
              });
              return { success: true, strategy: strategyName, ipCount: ips.length, sampleIps: processedIps.slice(0, 5) };
            }
        } catch (e) { console.log(`Tier 2 strategy '${strategyName}' failed for URL '${url}': ${e.message}`); }
    }
    
    throw new Error('所有探测方案均失败，无法从此URL提取IP。');
  }

async function apiProbeIpSource(request) {
  const { url, is_delayed, delay_min, delay_max } = await request.json();
  try {
    const tempSource = { is_delayed, delay_min, delay_max };
    const result = await probeSourceUrl(url, tempSource);
    return jsonResponse(result);
  } catch (e) {
    return jsonResponse({ error: e.message }, 400);
  }
}

async function fetchIpsFromSource(source) {
    const strategyFn = ALL_STRATEGIES[source.fetch_strategy];
  
    if (!strategyFn) {
        throw new Error(`Unknown fetch strategy: ${source.fetch_strategy}`);
    }
  
    const url = _du(source.url);
    const delayOptions = source.is_delayed ? { delay_min: source.delay_min, delay_max: source.delay_max } : {};
    const ips = await strategyFn(url, delayOptions);
    
    if (!ips || ips.length === 0) {
        throw new Error('No IPs found using the cached strategy.');
    }
    
    // 处理IPv6地址格式
    const processedIps = ips.map(ip => {
      // 检查是否是IPv6地址
      const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/i;
      
      if (ipv6Regex.test(ip.trim())) {
        return `[${ip.trim()}]`;
      }
      return ip.trim();
    });
    
    return processedIps;
  }

async function githubApiRequest(url, token, options = {}) {
  const headers = {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'DNS-Clone-Worker',
      'Accept': 'application/vnd.github.v3+json',
      ...options.headers,
  };
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
      const errorData = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(`GitHub API error (${response.status}): ${errorData.message}`);
  }
  return response;
}

async function ensureRepoExists(token, owner, repo, log) {
  const repoUrl = `${_d([104,116,116,112,115,58,47,47,97,112,105,46,103,105,116,104,117,98,46,99,111,109,47,114,101,112,111,115,47])}${owner}/${repo}`;
  try {
      await githubApiRequest(repoUrl, token);
      log(`仓库 '${owner}/${repo}' 已存在。`);
  } catch (e) {
      if (e.message.includes('404')) {
          log(`仓库 '${owner}/${repo}' 不存在，正在尝试创建...`);
          const createUrl = _d([104,116,116,112,115,58,47,47,97,112,105,46,103,105,116,104,117,98,46,99,111,109,47,117,115,101,114,47,114,101,112,111,115]);
          const body = JSON.stringify({
              name: repo,
              private: true,
              description: 'Auto-generated repository for IP source files by DNS Clone Worker.'
          });
          await githubApiRequest(createUrl, token, { method: 'POST', body });
          log(`✔ 成功创建私有仓库 '${owner}/${repo}'。`);
      } else {
          throw e;
      }
  }
}

async function getGitHubContent(token, owner, repo, path) {
    const apiUrl = `${_d([104,116,116,112,115,58,47,47,97,112,105,46,103,105,116,104,117,98,46,99,111,109,47,114,101,112,111,115,47])}${owner}/${repo}/contents/${path}`;
    try {
        const response = await githubApiRequest(apiUrl, token, {
            headers: { 'Accept': 'application/vnd.github.v3.raw' }
        });
        return await response.text();
    } catch (e) {
        if (e.message.includes('404')) {
            console.error(`GitHub file '${path}' not found.`);
            return null;
        }
        throw e;
    }
}

async function updateFileOnGitHub({ token, owner, repo, path, content, message, log }) {
    if (!content || content.trim() === '') {
      throw new Error("推送内容不能为空，已中止操作。");
    }
  
    // 处理IPv6地址，添加方括号
    const processedContent = content.split('\n').map(line => {
      const trimmedLine = line.trim();
      // 检查是否是IPv6地址
      const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/i;
      
      if (ipv6Regex.test(trimmedLine)) {
        return `[${trimmedLine}]`;
      }
      return trimmedLine;
    }).filter(line => line !== '').join('\n');
  
    await ensureRepoExists(token, owner, repo, log);
    
    const apiUrl = `${_d([104,116,116,112,115,58,47,47,97,112,105,46,103,105,116,104,117,98,46,99,111,109,47,114,101,112,111,115,47])}${owner}/${repo}/contents/${path}`;
    let sha;
    try {
        const getFileResponse = await githubApiRequest(apiUrl, token);
        const fileData = await getFileResponse.json();
        sha = fileData.sha;
    } catch (e) {
        if (!e.message.includes('404')) throw e;
    }
    
    const body = JSON.stringify({
        message,
        content: btoa(unescape(encodeURIComponent(processedContent))),
        sha
    });
  
    await githubApiRequest(apiUrl, token, { method: 'PUT', body });
    
    log(`推送内容已处理IPv6地址格式。`);
  }

function createLogStreamResponse(logFunction) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const log = (message) => {
      const logMsg = beijingTimeLog(message);
      try {
          writer.write(encoder.encode(`data: ${logMsg}\n\n`));
      } catch(e) {
          console.error("Failed to write to stream:", e);
      }
  };

  (async () => {
      try {
          await logFunction(log);
      } catch (e) {
          log(`[FATAL_ERROR] ${e.message}`);
          console.error("Streaming log function error:", e.stack);
      } finally {
          try {
              await writer.close();
          } catch (e) {}
      }
  })();

  return new Response(readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
  });
}

function normalizeContent(text) {
    if (typeof text !== 'string') return '';
    return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).join('\n');
}

async function syncSingleIpSourceToD1(id, env, log) {
    const db = env.WUYA;
    const AUTO_REPROBE_THRESHOLD = 2;

    const source = await db.prepare("SELECT * FROM ip_sources WHERE id = ?").bind(id).first();
    if (!source) throw new Error(`未找到ID为 ${id} 的IP源。`);

    log(`======== 开始处理IP源: ${_du(source.url)} ========`);

    if (source.consecutive_failures >= AUTO_REPROBE_THRESHOLD) {
        log(`源 [${_du(source.url)}] 已连续失败 ${source.consecutive_failures} 次，触发自动重探测...`);
        try {
            const result = await probeSourceUrl(_du(source.url), source);
            if (result.success && result.strategy) {
                log(`✔ 自动重探测成功！新策略: ${result.strategy}`);
                await db.prepare("UPDATE ip_sources SET fetch_strategy = ?, consecutive_failures = 0 WHERE id = ?")
                    .bind(result.strategy, id).run();
                source.fetch_strategy = result.strategy; 
            } else {
                 throw new Error("探测成功但未返回有效策略");
            }
        } catch (probeError) {
            log(`❌ 自动重探测失败: ${probeError.message}. 本次跳过该源。`);
            await db.prepare("UPDATE ip_sources SET consecutive_failures = consecutive_failures + 1 WHERE id = ?").bind(id).run();
            return;
        }
    }
    
    try {
        const ips = await fetchIpsFromSource(source);
        log(`成功从源获取 ${ips.length} 个IP。`);
        
        const newContent = ips.join('\n');
        const newHash = await generateHash(newContent);
        
        if (newHash === source.last_pushed_hash) {
            log(`内容无变化 (与上次推送至GitHub的内容一致)，无需操作。`);
            await db.prepare("UPDATE ip_sources SET last_synced_time = CURRENT_TIMESTAMP, last_sync_status = 'no_change', last_sync_error = NULL, consecutive_failures = 0, needs_push = 0 WHERE id = ?")
                .bind(id).run();
        } else {
            log(`内容已更新，暂存到数据库并标记为待推送。`);
            await db.prepare("UPDATE ip_sources SET last_synced_time = CURRENT_TIMESTAMP, last_sync_status = 'success', last_sync_error = NULL, consecutive_failures = 0, cached_content = ?, content_hash = ?, needs_push = 1 WHERE id = ?")
                .bind(newContent, newHash, id).run();
        }
        log(`✔ IP源 [${_du(source.url)}] 处理成功。`);
    } catch (e) {
        log(`❌ IP源 [${_du(source.url)}] 处理失败: ${e.message}`);
        await db.prepare("UPDATE ip_sources SET last_synced_time = CURRENT_TIMESTAMP, last_sync_status = 'failed', last_sync_error = ?, consecutive_failures = consecutive_failures + 1 WHERE id = ?")
            .bind(e.message, id).run();
        throw e;
    }
}

async function pushAllIpSourcesToGithub(env, returnLogs) {
  const syncLogic = async (log) => {
      log("开始手动触发所有待推送更新到GitHub...");
      await pushAllChangesToGithub(env, log);
      log("手动推送任务执行完毕。");
  };

  if (returnLogs) return createLogStreamResponse(syncLogic);
  
  const noOpLog = (msg) => console.log(beijingTimeLog(msg));
  await syncLogic(noOpLog);
}

async function pushAllChangesToGithub(env, log) {
    const db = env.WUYA;
    const githubSettings = await getGitHubSettings(db);
    if (!githubSettings.token || !githubSettings.owner || !githubSettings.repo) {
        log("❌ 推送失败: GitHub API设置不完整。");
        return;
    }

    const { results: sourcesToPush } = await db.prepare("SELECT * FROM ip_sources WHERE needs_push = 1 AND is_enabled = 1").all();

    if (sourcesToPush.length === 0) {
        log("没有需要推送到GitHub的更新。");
        return;
    }

    log(`发现 ${sourcesToPush.length} 个IP源有更新待推送到GitHub...`);
    await ensureRepoExists(githubSettings.token, githubSettings.owner, githubSettings.repo, log);

    for (const source of sourcesToPush) {
        log(`---\n pushing: ${source.github_path}`);
        try {
            await updateFileOnGitHub({ 
                ...githubSettings, 
                path: source.github_path, 
                content: source.cached_content, 
                message: source.commit_message, 
                log 
            });
            
            await db.prepare("UPDATE ip_sources SET last_pushed_hash = ?, needs_push = 0, last_synced_time = CURRENT_TIMESTAMP, last_sync_status = 'success' WHERE id = ?")
                .bind(source.content_hash, source.id).run();

            log(`✔ 成功推送 ${source.github_path} 到GitHub。`);

        } catch (e) {
            log(`❌ 推送 ${source.github_path} 失败: ${e.message}`);
        }
    }
}

async function handleGitHubFileProxy(fileName, env, ctx) {
    const db = env.WUYA;
    const githubSettings = await getGitHubSettings(db);
    const source = await db.prepare("SELECT * FROM ip_sources WHERE github_path = ?").bind(fileName).first();
  
    if (!source) {
        return new Response('File not found or not managed by this service.', { status: 404 });
    }
  
    if (!githubSettings.token || !githubSettings.owner || !githubSettings.repo) {
        return new Response('GitHub settings are not configured on the server.', { status: 500 });
    }
    
    const cache = caches.default;
    const cacheKey = new Request(new URL(fileName, _d([104,116,116,112,115,58,47,47,103,105,116,104,117,98,45,112,114,111,120,121,46,99,97,99,104,101])).toString());
    let response = await cache.match(cacheKey);
  
    if (!response) {
        const apiUrl = `${_d([104,116,116,112,115,58,47,47,97,112,105,46,103,105,116,104,117,98,46,99,111,109,47,114,101,112,111,115,47])}${githubSettings.owner}/${githubSettings.repo}/contents/${fileName}`;
        
        const githubResponse = await githubApiRequest(apiUrl, githubSettings.token, {
            headers: { 'Accept': 'application/vnd.github.v3.raw' }
        });
  
        if (!githubResponse.ok) {
            return new Response('Failed to fetch file from GitHub.', { status: githubResponse.status });
        }
        
        const content = await githubResponse.text();
        
        // 处理IPv6地址格式
        const processedContent = content.split('\n').map(line => {
          const trimmedLine = line.trim();
          // 检查是否是IPv6地址（可能已经带方括号，也可能没有）
          const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/i;
          
          // 如果已经是带方括号的IPv6地址，保持原样
          if (trimmedLine.startsWith('[') && trimmedLine.endsWith(']')) {
            return trimmedLine;
          }
          
          if (ipv6Regex.test(trimmedLine)) {
            return `[${trimmedLine}]`;
          }
          return trimmedLine;
        }).filter(line => line !== '').join('\n');
        
        response = new Response(processedContent, {
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 's-maxage=300'
            }
        });
        
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
  
    return response;
  }

async function syncDomainLogic(domain, token, zoneId, db, log, syncContext) {
    log(`======== 开始同步: ${domain.target_domain} ========`);
    try {
        let recordsToUpdate;
        if (domain.source_domain.startsWith('internal:hostmonit:')) {
            const type = domain.source_domain.split(':')[2];
            if (!syncContext.threeNetworkIps) {
                throw new Error("三网优选IP上下文未准备好, 系统域名应该由 syncSystemDomainsAsUnit 处理。");
            }
            const ips = syncContext.threeNetworkIps[type] || [];
            recordsToUpdate = ips.map(ip => ({ type: 'A', content: ip }));
        } else if (domain.is_deep_resolve) {
            log(`模式: 深度解析 (追踪CNAME)`);
            recordsToUpdate = await resolveRecursively(domain.source_domain, log);
        } else {
            log(`模式: 浅层克隆 (直接克隆CNAME)`);
            const cnames = await getDnsFromDoh(domain.source_domain, 'CNAME');
            if (cnames.length > 0) {
                recordsToUpdate = [{ type: 'CNAME', content: cnames[0].replace(/\.$/, "") }];
            } else {
                recordsToUpdate = [];
            }
        }
  
        if (!recordsToUpdate || recordsToUpdate.length === 0) {
            log(`警告: 源域名 ${domain.source_domain} 未解析到任何有效记录，本次跳过更新。`);
            await db.prepare("UPDATE domains SET last_synced_time = CURRENT_TIMESTAMP, last_sync_status = 'failed', last_sync_error = ? WHERE id = ?").bind('源域名无解析', domain.id).run();
            return;
        }
  
        const recordLimit = domain.resolve_record_limit || 10;
        if (recordsToUpdate.length > recordLimit) {
            log(`解析到 ${recordsToUpdate.length} 条记录，根据上限(${recordLimit})进行截取。`);
            recordsToUpdate = recordsToUpdate.slice(0, recordLimit);
        }
        
        const { allZoneRecords } = syncContext;
        const zoneName = await getZoneName(token, zoneId);
  
        let operations = [];
  
        const existingMainRecords = allZoneRecords.filter(r => r.name === domain.target_domain);
        const mainChanges = calculateDnsChanges(existingMainRecords, recordsToUpdate, domain);
        operations.push(...mainChanges.toDelete.map(rec => ({ action: 'delete', record: rec })));
        operations.push(...mainChanges.toAdd.map(rec => ({ action: 'add', record: rec, domain: domain })));
  
        const targetPrefix = domain.target_domain.replace(`.${zoneName}`, '');
        if (targetPrefix !== domain.target_domain) {
            const singleResolveRegex = new RegExp(`^${targetPrefix.replace(/\./g, '\\.')}\\.\\d+\\.${zoneName.replace(/\./g, '\\.')}$`);
            const existingSingleRecords = allZoneRecords.filter(r => singleResolveRegex.test(r.name));
            
            const recordsForSingleResolve = domain.is_single_resolve ? recordsToUpdate.slice(0, domain.single_resolve_limit || 5) : [];
            
            const newSingleDomainNames = new Set();
            for (let i = 0; i < recordsForSingleResolve.length; i++) {
                const singleDomainName = `${targetPrefix}.${i + 1}.${zoneName}`;
                newSingleDomainNames.add(singleDomainName);
                
                const record = recordsForSingleResolve[i];
                const existing = existingSingleRecords.filter(r => r.name === singleDomainName);
                const singleDomain = { ...domain, target_domain: singleDomainName };
                const changes = calculateDnsChanges(existing, [record], singleDomain);
                operations.push(...changes.toDelete.map(rec => ({ action: 'delete', record: rec })));
                operations.push(...changes.toAdd.map(rec => ({ action: 'add', record: rec, domain: singleDomain })));
            }
            
            const recordsToClean = existingSingleRecords.filter(r => !newSingleDomainNames.has(r.name));
            operations.push(...recordsToClean.map(rec => ({ action: 'delete', record: rec })));
        }
  
        if (operations.length === 0) {
            log(`所有记录无变化，无需操作。`);
            await db.prepare("UPDATE domains SET last_synced_records = ?, displayed_records = ?, last_synced_time = CURRENT_TIMESTAMP, last_sync_status = 'no_change', last_sync_error = NULL WHERE id = ?")
              .bind(JSON.stringify(recordsToUpdate), JSON.stringify(recordsToUpdate), domain.id).run();
            log(`✔ 同步完成 ${domain.target_domain} (内容一致)。`);
        } else {
            log(`共计 ${operations.length} 个操作待执行。`);
            await executeDnsOperations(token, zoneId, operations, log);
            await db.prepare("UPDATE domains SET last_synced_records = ?, displayed_records = ?, last_synced_time = CURRENT_TIMESTAMP, last_sync_status = 'success', last_sync_error = NULL WHERE id = ?")
              .bind(JSON.stringify(recordsToUpdate), JSON.stringify(recordsToUpdate), domain.id).run();
            log(`✔ 同步完成 ${domain.target_domain} (内容已更新)。`);
        }
  
    } catch (e) {
        log(`❌ 同步 ${domain.target_domain} 失败: ${e.message}`);
        await db.prepare("UPDATE domains SET last_synced_time = CURRENT_TIMESTAMP, last_sync_status = 'failed', last_sync_error = ? WHERE id = ?").bind(e.message, domain.id).run();
        throw e;
    }
  }

async function syncSingleDomain(id, env, returnLogs, log = console.log) {
    const db = env.WUYA;
    const syncLogic = async (innerLog) => {
        const { token, zoneId } = await getCfApiSettings(db);
        if (!token || !zoneId) throw new Error("尚未配置 Cloudflare API 令牌或区域 ID。");
        const domain = await db.prepare("SELECT * FROM domains WHERE id = ?").bind(id).first();
        if (!domain) throw new Error(`未找到 ID 为 ${id} 的目标。`);
        if (!domain.is_enabled) {
            innerLog(`域名 ${domain.target_domain} 已被禁用，跳过同步。`);
            return;
        }
        
        const allZoneRecords = await listAllDnsRecords(token, zoneId);
        const syncContext = { allZoneRecords };
        
        // 如果是系统域名，单独处理
        if (domain.source_domain.startsWith('internal:hostmonit:')) {
            innerLog(`系统域名 ${domain.target_domain} 应由系统域名同步统一处理`);
            return;
        }
        
        // 非系统域名，正常处理
        let recordsToUpdate;
        if (domain.is_deep_resolve) {
            innerLog(`模式: 深度解析 (追踪CNAME)`);
            recordsToUpdate = await resolveRecursively(domain.source_domain, innerLog);
        } else {
            innerLog(`模式: 浅层克隆 (直接克隆CNAME)`);
            const cnames = await getDnsFromDoh(domain.source_domain, 'CNAME');
            if (cnames.length > 0) {
                recordsToUpdate = [{ type: 'CNAME', content: cnames[0].replace(/\.$/, "") }];
            } else {
                recordsToUpdate = [];
            }
        }
  
        if (!recordsToUpdate || recordsToUpdate.length === 0) {
            innerLog(`警告: 源域名 ${domain.source_domain} 未解析到任何有效记录，本次跳过更新。`);
            await db.prepare("UPDATE domains SET last_synced_time = CURRENT_TIMESTAMP, last_sync_status = 'failed', last_sync_error = ? WHERE id = ?").bind('源域名无解析', domain.id).run();
            return;
        }
  
        const recordLimit = domain.resolve_record_limit || 10;
        if (recordsToUpdate.length > recordLimit) {
            innerLog(`解析到 ${recordsToUpdate.length} 条记录，根据上限(${recordLimit})进行截取。`);
            recordsToUpdate = recordsToUpdate.slice(0, recordLimit);
        }
        
        const zoneName = await getZoneName(token, zoneId);
  
        let operations = [];
  
        const existingMainRecords = allZoneRecords.filter(r => r.name === domain.target_domain);
        const mainChanges = calculateDnsChanges(existingMainRecords, recordsToUpdate, domain);
        operations.push(...mainChanges.toDelete.map(rec => ({ action: 'delete', record: rec })));
        operations.push(...mainChanges.toAdd.map(rec => ({ action: 'add', record: rec, domain: domain })));
  
        const targetPrefix = domain.target_domain.replace(`.${zoneName}`, '');
        if (targetPrefix !== domain.target_domain) {
            const singleResolveRegex = new RegExp(`^${targetPrefix.replace(/\./g, '\\.')}\\.\\d+\\.${zoneName.replace(/\./g, '\\.')}$`);
            const existingSingleRecords = allZoneRecords.filter(r => singleResolveRegex.test(r.name));
            
            const recordsForSingleResolve = domain.is_single_resolve ? recordsToUpdate.slice(0, domain.single_resolve_limit || 5) : [];
            
            const newSingleDomainNames = new Set();
            for (let i = 0; i < recordsForSingleResolve.length; i++) {
                const singleDomainName = `${targetPrefix}.${i + 1}.${zoneName}`;
                newSingleDomainNames.add(singleDomainName);
                
                const record = recordsForSingleResolve[i];
                const existing = existingSingleRecords.filter(r => r.name === singleDomainName);
                const singleDomain = { ...domain, target_domain: singleDomainName };
                const changes = calculateDnsChanges(existing, [record], singleDomain);
                operations.push(...changes.toDelete.map(rec => ({ action: 'delete', record: rec })));
                operations.push(...changes.toAdd.map(rec => ({ action: 'add', record: rec, domain: singleDomain })));
            }
            
            const recordsToClean = existingSingleRecords.filter(r => !newSingleDomainNames.has(r.name));
            operations.push(...recordsToClean.map(rec => ({ action: 'delete', record: rec })));
        }
  
        if (operations.length === 0) {
            innerLog(`所有记录无变化，无需操作。`);
            await db.prepare("UPDATE domains SET last_synced_records = ?, displayed_records = ?, last_synced_time = CURRENT_TIMESTAMP, last_sync_status = 'no_change', last_sync_error = NULL WHERE id = ?")
              .bind(JSON.stringify(recordsToUpdate), JSON.stringify(recordsToUpdate), domain.id).run();
            innerLog(`✔ 同步完成 ${domain.target_domain} (内容一致)。`);
        } else {
            innerLog(`共计 ${operations.length} 个操作待执行。`);
            await executeDnsOperations(token, zoneId, operations, innerLog);
            await db.prepare("UPDATE domains SET last_synced_records = ?, displayed_records = ?, last_synced_time = CURRENT_TIMESTAMP, last_sync_status = 'success', last_sync_error = NULL WHERE id = ?")
              .bind(JSON.stringify(recordsToUpdate), JSON.stringify(recordsToUpdate), domain.id).run();
            innerLog(`✔ 同步完成 ${domain.target_domain} (内容已更新)。`);
        }
    };
  
    if (returnLogs) return createLogStreamResponse(syncLogic);
    
    await syncLogic(log).catch(e => log(`[ERROR] ${e.message}`));
  }

  async function syncSystemDomainsAsUnit(env, log) {
    const db = env.WUYA;
    log("======== 开始同步三网优选域名(作为一个整体) ========");
    
    try {
        const { token, zoneId } = await getCfApiSettings(db);
        if (!token || !zoneId) throw new Error("尚未配置 Cloudflare API。");

        const { results: systemDomains } = await db.prepare("SELECT * FROM domains WHERE is_enabled = 1 AND is_system = 1").all();
        if (systemDomains.length === 0) {
            log("没有已启用的系统域名需要同步。");
            return;
        }

        const sourceName = await getSetting(db, 'THREE_NETWORK_SOURCE') || 'CloudFlareYes';
        log(`正在从 ${sourceName} 获取三网优选IP...`);
        const threeNetworkIps = await fetchThreeNetworkIps(sourceName, systemDomains, log);
        if (!threeNetworkIps || (threeNetworkIps.yd.length === 0 && threeNetworkIps.dx.length === 0 && threeNetworkIps.lt.length === 0)) {
            throw new Error(`从 ${sourceName} 未获取到任何三网IP。`);
        }
        log(`获取成功: 移动(${threeNetworkIps.yd.length}) 电信(${threeNetworkIps.dx.length}) 联通(${threeNetworkIps.lt.length})`);

        const allZoneRecords = await listAllDnsRecords(token, zoneId);
        const syncContext = { allZoneRecords, threeNetworkIps };

        // 为每个域名单独处理，而不是收集所有操作
        for (const domain of systemDomains) {
            log(`处理系统域名: ${domain.target_domain}`);
            
            const type = domain.source_domain.split(':')[2];
            const ips = threeNetworkIps[type] || [];
            const recordsToUpdate = ips.map(ip => ({ type: 'A', content: ip }));
            
            if (recordsToUpdate.length === 0) {
                log(`警告: 系统域名 ${domain.target_domain} 没有获取到IP，跳过更新。`);
                continue;
            }
            
            const recordLimit = domain.resolve_record_limit || 10;
            const finalRecords = recordsToUpdate.slice(0, recordLimit);
            
            const existingMainRecords = allZoneRecords.filter(r => r.name === domain.target_domain);
            const mainChanges = calculateDnsChanges(existingMainRecords, finalRecords, domain);
            
            let operations = [];
            operations.push(...mainChanges.toDelete.map(rec => ({ action: 'delete', record: rec })));
            operations.push(...mainChanges.toAdd.map(rec => ({ action: 'add', record: rec, domain: domain })));
            
            // 处理单个解析子域名
            const zoneName = await getZoneName(token, zoneId);
            const targetPrefix = domain.target_domain.replace(`.${zoneName}`, '');
            if (targetPrefix !== domain.target_domain) {
                const singleResolveRegex = new RegExp(`^${targetPrefix.replace(/\./g, '\\.')}\\.\\d+\\.${zoneName.replace(/\./g, '\\.')}$`);
                const existingSingleRecords = allZoneRecords.filter(r => singleResolveRegex.test(r.name));
                
                const recordsForSingleResolve = domain.is_single_resolve ? finalRecords.slice(0, domain.single_resolve_limit || 5) : [];
                
                const newSingleDomainNames = new Set();
                for (let i = 0; i < recordsForSingleResolve.length; i++) {
                    const singleDomainName = `${targetPrefix}.${i + 1}.${zoneName}`;
                    newSingleDomainNames.add(singleDomainName);
                    
                    const record = recordsForSingleResolve[i];
                    const existing = existingSingleRecords.filter(r => r.name === singleDomainName);
                    const singleDomain = { ...domain, target_domain: singleDomainName };
                    const changes = calculateDnsChanges(existing, [record], singleDomain);
                    operations.push(...changes.toDelete.map(rec => ({ action: 'delete', record: rec })));
                    operations.push(...changes.toAdd.map(rec => ({ action: 'add', record: rec, domain: singleDomain })));
                }
                
                const recordsToClean = existingSingleRecords.filter(r => !newSingleDomainNames.has(r.name));
                operations.push(...recordsToClean.map(rec => ({ action: 'delete', record: rec })));
            }
            
            // 执行操作
            if (operations.length === 0) {
                log(`系统域名 ${domain.target_domain} 所有记录无变化，无需操作。`);
            } else {
                log(`系统域名 ${domain.target_domain} 执行 ${operations.length} 个操作。`);
                await executeDnsOperations(token, zoneId, operations, log);
            }
            
            // 更新数据库状态
            await db.prepare("UPDATE domains SET last_synced_records = ?, displayed_records = ?, last_synced_time = CURRENT_TIMESTAMP, last_sync_status = 'success', last_sync_error = NULL WHERE id = ?")
                .bind(JSON.stringify(finalRecords), JSON.stringify(finalRecords), domain.id).run();
            
            log(`✔ 系统域名 ${domain.target_domain} 同步完成。`);
            
            // 在域名之间添加延迟，避免子请求过多
            if (domain !== systemDomains[systemDomains.length - 1]) {
                log(`等待2秒后处理下一个系统域名...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        
        log("✔ 三网优选域名同步完成。");
    } catch(e) {
        log(`❌ 三网优选域名同步失败: ${e.message}`);
        throw e;
    } finally {
        await db.prepare("UPDATE domains SET needs_sync = 0 WHERE is_system = 1").run();
    }
}

// 新函数：计算域名操作但不执行
async function calculateDomainOperations(domain, token, zoneId, db, log, syncContext) {
    log(`处理域名: ${domain.target_domain}`);
    
    let recordsToUpdate;
    if (domain.source_domain.startsWith('internal:hostmonit:')) {
        const type = domain.source_domain.split(':')[2];
        if (!syncContext.threeNetworkIps) {
            throw new Error("三网优选IP上下文未准备好。");
        }
        const ips = syncContext.threeNetworkIps[type] || [];
        recordsToUpdate = ips.map(ip => ({ type: 'A', content: ip }));
    } else if (domain.is_deep_resolve) {
        log(`模式: 深度解析 (追踪CNAME)`);
        recordsToUpdate = await resolveRecursively(domain.source_domain, log);
    } else {
        log(`模式: 浅层克隆 (直接克隆CNAME)`);
        const cnames = await getDnsFromDoh(domain.source_domain, 'CNAME');
        if (cnames.length > 0) {
            recordsToUpdate = [{ type: 'CNAME', content: cnames[0].replace(/\.$/, "") }];
        } else {
            recordsToUpdate = [];
        }
    }

    if (!recordsToUpdate || recordsToUpdate.length === 0) {
        log(`警告: 源域名 ${domain.source_domain} 未解析到任何有效记录。`);
        return [];
    }

    const recordLimit = domain.resolve_record_limit || 10;
    if (recordsToUpdate.length > recordLimit) {
        log(`解析到 ${recordsToUpdate.length} 条记录，根据上限(${recordLimit})进行截取。`);
        recordsToUpdate = recordsToUpdate.slice(0, recordLimit);
    }
    
    const { allZoneRecords } = syncContext;
    const zoneName = await getZoneName(token, zoneId);

    let operations = [];

    const existingMainRecords = allZoneRecords.filter(r => r.name === domain.target_domain);
    const mainChanges = calculateDnsChanges(existingMainRecords, recordsToUpdate, domain);
    operations.push(...mainChanges.toDelete.map(rec => ({ action: 'delete', record: rec })));
    operations.push(...mainChanges.toAdd.map(rec => ({ action: 'add', record: rec, domain: domain })));

    const targetPrefix = domain.target_domain.replace(`.${zoneName}`, '');
    if (targetPrefix !== domain.target_domain) {
        const singleResolveRegex = new RegExp(`^${targetPrefix.replace(/\./g, '\\.')}\\.\\d+\\.${zoneName.replace(/\./g, '\\.')}$`);
        const existingSingleRecords = allZoneRecords.filter(r => singleResolveRegex.test(r.name));
        
        const recordsForSingleResolve = domain.is_single_resolve ? recordsToUpdate.slice(0, domain.single_resolve_limit || 5) : [];
        
        const newSingleDomainNames = new Set();
        for (let i = 0; i < recordsForSingleResolve.length; i++) {
            const singleDomainName = `${targetPrefix}.${i + 1}.${zoneName}`;
            newSingleDomainNames.add(singleDomainName);
            
            const record = recordsForSingleResolve[i];
            const existing = existingSingleRecords.filter(r => r.name === singleDomainName);
            const singleDomain = { ...domain, target_domain: singleDomainName };
            const changes = calculateDnsChanges(existing, [record], singleDomain);
            operations.push(...changes.toDelete.map(rec => ({ action: 'delete', record: rec })));
            operations.push(...changes.toAdd.map(rec => ({ action: 'add', record: rec, domain: singleDomain })));
        }
        
        const recordsToClean = existingSingleRecords.filter(r => !newSingleDomainNames.has(r.name));
        operations.push(...recordsToClean.map(rec => ({ action: 'delete', record: rec })));
    }
    
    return operations;
}

async function syncAllDomains(env, returnLogs, log = console.log) {
    const db = env.WUYA;
    const syncLogic = async (innerLog) => {
      innerLog("开始批量同步所有域名...");
      
      try {
        // 先同步系统域名
        innerLog("正在同步系统域名...");
        await syncSystemDomainsAsUnit(env, innerLog);
        innerLog("系统域名同步完成。");
      } catch(e) {
        innerLog(`系统域名同步失败: ${e.message}`);
      }
      
      // 获取所有非系统域名
      const { results: nonSystemDomains } = await db.prepare("SELECT * FROM domains WHERE is_enabled = 1 AND is_system = 0 ORDER BY id").all();
      if (nonSystemDomains.length === 0) {
        innerLog("没有需要同步的非系统域名。");
      } else {
        innerLog(`发现 ${nonSystemDomains.length} 个非系统域名需要同步。`);
        
        // 按顺序同步，每个域名间隔3秒
        for (let i = 0; i < nonSystemDomains.length; i++) {
          const domain = nonSystemDomains[i];
          innerLog(`正在同步域名 (${i + 1}/${nonSystemDomains.length}): ${domain.target_domain}`);
          
          try {
            // 使用单个域名的同步API
            await syncSingleDomain(domain.id, env, false, (msg) => {
              innerLog(msg);
            });
          } catch(e) {
            innerLog(`处理域名 ${domain.target_domain} 失败: ${e.message}`);
          }
          
          // 如果不是最后一个域名，等待3秒
          if (i < nonSystemDomains.length - 1) {
            innerLog(`等待3秒后继续下一个域名...`);
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        }
      }
      innerLog("所有域名同步任务执行完毕。");
    };
  
    if (returnLogs) return createLogStreamResponse(syncLogic);
    
    await syncLogic(log);
  }
  
  // 辅助函数：调用单个域名的同步API并等待完成
  async function fetchAndWait(apiUrl, log) {
    return new Promise((resolve, reject) => {
      const eventSource = new EventSource(apiUrl);
      let hasError = false;
      
      eventSource.onmessage = (event) => {
        const message = event.data;
        log(message);
        
        // 检测是否完成
        if (message.includes('任务完成') || message.includes('内容已更新') || message.includes('内容一致')) {
          eventSource.close();
          if (!hasError) {
            resolve();
          }
        }
      };
      
      eventSource.onerror = (error) => {
        hasError = true;
        log(`❌ 同步失败: ${error}`);
        eventSource.close();
        reject(new Error('同步失败'));
      };
      
      // 设置超时
      setTimeout(() => {
        if (!hasError) {
          log('⚠️ 同步超时，继续下一个域名');
          eventSource.close();
          resolve();
        }
      }, 60000); // 60秒超时
    });
  }

async function syncSystemDomains(env, returnLogs) {
  return createLogStreamResponse((log) => syncSystemDomainsAsUnit(env, log));
}

async function resolveRecursively(domain, log, depth = 0) {
const MAX_DEPTH = 10;
if (depth > MAX_DEPTH) {
  log(`错误：解析深度超过 ${MAX_DEPTH} 层，可能存在CNAME循环。中止解析 ${domain}。`);
  return [];
}
log(`(深度 ${depth}) 正在解析: ${domain}`);
const cnames = await getDnsFromDoh(domain, 'CNAME');
if (cnames.length > 0) {
  const cnameTarget = cnames[0].replace(/\.$/, "");
  log(`(深度 ${depth}) 发现CNAME -> ${cnameTarget}`);
  const nextRecords = await resolveRecursively(cnameTarget, log, depth + 1);
  if (nextRecords.length > 0 && nextRecords.some(r => r.type !== 'CNAME')) {
      return nextRecords;
  }
  log(`(深度 ${depth + 1}) CNAME ${cnameTarget} 未解析到最终IP，将直接克隆此CNAME记录。`);
  return [{ type: 'CNAME', content: cnameTarget }];
}
log(`(深度 ${depth}) 未发现CNAME，查询最终IP for ${domain}`);
const ipv4s = await getDnsFromDoh(domain, 'A');
const ipv6s = await getDnsFromDoh(domain, 'AAAA');
const validIPv4s = ipv4s.filter(ip => /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(ip));
const validIPv6s = ipv6s.filter(ip => {
  const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/i;
  return ipv6Regex.test(ip);
});
const records = [
  ...validIPv4s.map(ip => ({ type: 'A', content: ip })), 
  ...validIPv6s.map(ip => ({ 
    type: 'AAAA', 
    content: ip  // DNS记录中IPv6地址不需要方括号
  }))
];
return records;
}

function calculateDnsChanges(existingRecords, newRecords, domain) {
    const { ttl, is_single_resolve } = domain;
    
    const toDelete = [];
    let toAdd = newRecords.map(r => ({ ...r, content: r.content.replace(/\.$/, "") }));
  
    if (!is_single_resolve) {
        const sortFn = (a, b) => a.content.localeCompare(b.content);
        toAdd.sort(sortFn);
        existingRecords = [...existingRecords].sort(sortFn);
    }
  
    const newRecordIsCname = toAdd.some(r => r.type === 'CNAME');
  
    for (const existing of existingRecords) {
        const normalizedExistingContent = existing.content.replace(/\.$/, "");
        
        // 如果新记录是CNAME而旧记录是A/AAAA/CNAME，或者反之，都需要删除旧记录
        if ((newRecordIsCname && ['A', 'AAAA', 'CNAME'].includes(existing.type)) || 
            (!newRecordIsCname && existing.type === 'CNAME')) {
            toDelete.push(existing);
            continue;
        }
        
        // 查找匹配的记录
        let foundExactMatch = false;
        for (let i = toAdd.length - 1; i >= 0; i--) {
            if (toAdd[i].type === existing.type && toAdd[i].content === normalizedExistingContent) {
                // 检查是否需要更新TTL或代理状态
                if (existing.proxied === false && existing.ttl === ttl) {
                    // 完全相同，无需任何操作
                    toAdd.splice(i, 1);
                    foundExactMatch = true;
                    break;
                } else {
                    // 内容相同但TTL或代理状态不同，需要删除旧记录再添加新记录
                    toDelete.push(existing);
                    // 保留toAdd中的记录，稍后会添加
                    foundExactMatch = true;
                    break;
                }
            }
        }
        
        // 如果没有找到匹配的记录，删除旧记录
        if (!foundExactMatch && ['A', 'AAAA', 'CNAME'].includes(existing.type)) {
            toDelete.push(existing);
        }
    }
    
    return { toDelete, toAdd };
  }
  

  async function executeDnsOperations(token, zoneId, operations, log) {
    const API_CHUNK_SIZE = 5; // 批处理大小
    const API_ENDPOINT = `${_d([104,116,116,112,115,58,47,47,97,112,105,46,99,108,111,117,100,102,108,97,114,101,46,99,111,109,47,99,108,105,101,110,116,47,118,52,47,122,111,110,101,115,47])}${zoneId}/dns_records`;
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  
    log(`总计操作: ${operations.length}`);
    
    // 首先执行所有删除操作
    const deleteOps = operations.filter(op => op.action === 'delete');
    const addOps = operations.filter(op => op.action === 'add');
    
    // 先删除，等待一小段时间确保删除完成
    if (deleteOps.length > 0) {
      log(`开始执行 ${deleteOps.length} 个删除操作...`);
      for (let i = 0; i < deleteOps.length; i += API_CHUNK_SIZE) {
        const chunk = deleteOps.slice(i, i + API_CHUNK_SIZE);
        
        const promises = chunk.map(op => {
          log(`- 删除旧记录: [${op.record.type}] ${op.record.content} for ${op.record.name}`);
          return () => fetch(`${API_ENDPOINT}/${op.record.id}`, { method: 'DELETE', headers });
        }).filter(Boolean);
  
        const responses = await Promise.all(promises.map(p => p()));
        for (const res of responses) {
          if (!res.ok) {
            const errorBody = await res.json().catch(() => ({ errors: [{ code: 9999, message: 'Unknown error' }] }));
            const errorMessage = (errorBody.errors || []).map(e => `(Code ${e.code}: ${e.message})`).join(', ');
            throw new Error(`删除操作失败: ${res.status} - ${errorMessage}`);
          }
        }
        
        // 在批处理之间添加延迟
        if (i + API_CHUNK_SIZE < deleteOps.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      log(`删除操作完成。`);
      
      // 等待2秒，确保删除操作完全生效
      log(`等待2秒，确保删除操作完全生效...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // 然后执行添加操作
    if (addOps.length > 0) {
      log(`开始执行 ${addOps.length} 个添加操作...`);
      for (let i = 0; i < addOps.length; i += API_CHUNK_SIZE) {
        const chunk = addOps.slice(i, i + API_CHUNK_SIZE);
        
        const promises = chunk.map(op => {
          const { record, domain } = op;
          log(`+ 添加新记录: [${record.type}] ${record.content} for ${domain.target_domain} (TTL: ${domain.ttl})`);
          return () => fetch(API_ENDPOINT, { 
            method: 'POST', 
            headers, 
            body: JSON.stringify({ 
              type: record.type, 
              name: domain.target_domain, 
              content: record.content, 
              ttl: domain.ttl, 
              proxied: false 
            }) 
          });
        }).filter(Boolean);
  
        const responses = await Promise.all(promises.map(p => p()));
        for (const res of responses) {
          if (!res.ok) {
            const errorBody = await res.json().catch(() => ({ errors: [{ code: 9999, message: 'Unknown error' }] }));
            const errorMessage = (errorBody.errors || []).map(e => `(Code ${e.code}: ${e.message})`).join(', ');
            log(`添加操作失败详情: ${errorMessage}`);
            throw new Error(`添加操作失败: ${res.status} - ${errorMessage}`);
          }
        }
        
        // 在批处理之间添加延迟
        if (i + API_CHUNK_SIZE < addOps.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      log(`添加操作完成。`);
    }
    
    if (deleteOps.length === 0 && addOps.length === 0) {
      log(`无需执行任何DNS操作。`);
    }
    
    log(`所有DNS操作执行完成。`);
  }
  

async function listAllDnsRecords(token, zoneId) {
  const API_ENDPOINT = `${_d([104,116,116,112,115,58,47,47,97,112,105,46,99,108,111,117,100,102,108,97,114,101,46,99,111,109,47,99,108,105,101,110,116,47,118,52,47,122,111,110,101,115,47])}${zoneId}/dns_records?per_page=500`;
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  const response = await fetch(API_ENDPOINT, { headers });
  if (!response.ok) throw new Error(`获取DNS记录列表失败: ${await response.text()}`);
  const data = await response.json();
  if (!data.success) throw new Error(`获取DNS记录列表API错误: ${JSON.stringify(data.errors)}`);
  return data.result;
}

async function getZoneName(token, zoneId) {
if (!token || !zoneId) throw new Error("API 令牌和区域 ID 不能为空。");
const response = await fetch(`${_d([104,116,116,112,115,58,47,47,97,112,105,46,99,108,111,117,100,102,108,97,114,101,46,99,111,109,47,99,108,105,101,110,116,47,118,52,47,122,111,110,101,115,47])}${zoneId}`, { headers: { 'Authorization': `Bearer ${token}` } });
if (!response.ok) { const errText = await response.text(); throw new Error(`无法从 Cloudflare 获取区域信息: ${errText}`); }
const data = await response.json();
if (!data.success) throw new Error(`Cloudflare API 返回错误: ${JSON.stringify(data.errors)}`);
return data.result.name;
}

async function hashPassword(password, salt) { const data = new TextEncoder().encode(password + salt); const hashBuffer = await crypto.subtle.digest('SHA-256', data); return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join(''); }
async function isAuthenticated(request, db) { const token = getCookie(request, 'session'); if (!token) return false; const session = await db.prepare("SELECT expires_at FROM sessions WHERE token = ?").bind(token).first(); if (!session || new Date(session.expires_at) < new Date()) { if (session) await db.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run(); return false; } return true; }
function getCookie(request, name) { const cookieHeader = request.headers.get('Cookie'); if (cookieHeader) for (let cookie of cookieHeader.split(';')) { const [key, value] = cookie.trim().split('='); if (key === name) return value; } return null; }
function jsonResponse(data, status = 200, headers = {}) { return new Response(JSON.stringify(data, null, 2), { status, headers: { 'Content-Type': 'application/json;charset=UTF-8', ...headers } }); }
const beijingTimeLog = (message) => `[${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}] ${message}`;
async function getDnsFromDoh(domain, type) { try { const url = `${_d([104,116,116,112,115,58,47,47,99,108,111,117,100,102,108,97,114,101,45,100,110,115,46,99,111,109,47,100,110,115,45,113,117,101,114,121,63,110,97,109,101,61])}${encodeURIComponent(domain)}&type=${type}`; const response = await fetch(url, { headers: { 'accept': 'application/dns-json' }, cache: "no-store" }); if (!response.ok) { console.warn(`DoH query failed for ${domain} (${type}): ${response.statusText}`); return []; } const data = await response.json(); return data.Answer ? data.Answer.map(ans => ans.data).filter(Boolean) : []; } catch (e) { console.error(`DoH query error for ${domain} (${type}): ${e.message}`); return []; } }

async function fetchThreeNetworkIps(source, systemDomains, log) {
  log(`正在从源 [${source}] 获取IP...`);

  async function parseHtmlTableWithOperator(htmlContent) {
      const ips = { yd: new Set(), dx: new Set(), lt: new Set() };
      const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      const ipRegex = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;

      let rowMatch;
      while ((rowMatch = rowRegex.exec(htmlContent)) !== null) {
          const cells = Array.from(rowMatch[1].matchAll(cellRegex), m => m[1].replace(/<[^>]+>/g, '').trim());
          if (cells.length >= 2) {
              const lineCell = cells.find(c => c.includes('电信') || c.includes('联通') || c.includes('移动'));
              const ipCell = cells.find(c => ipRegex.test(c));

              if (lineCell && ipCell) {
                  const ip = ipCell.match(ipRegex)[0];
                  if (lineCell.includes('移动')) ips.yd.add(ip);
                  else if (lineCell.includes('电信')) ips.dx.add(ip);
                  else if (lineCell.includes('联通')) ips.lt.add(ip);
              }
          }
      }
      
      const allIpsArray = [...ips.yd, ...ips.dx, ...ips.lt];
      if (allIpsArray.length > 0) {
          const allIps = new Set(allIpsArray);
          if (ips.yd.size === 0) ips.yd = allIps;
          if (ips.dx.size === 0) ips.dx = allIps;
          if (ips.lt.size === 0) ips.lt = allIps;
      }
      
      const limits = {
          yd: systemDomains.find(d => d.source_domain.endsWith(':yd'))?.resolve_record_limit || 3,
          dx: systemDomains.find(d => d.source_domain.endsWith(':dx'))?.resolve_record_limit || 3,
          lt: systemDomains.find(d => d.source_domain.endsWith(':lt'))?.resolve_record_limit || 3
      };
      
      return { 
          yd: Array.from(ips.yd).slice(0, limits.yd), 
          dx: Array.from(ips.dx).slice(0, limits.dx), 
          lt: Array.from(ips.lt).slice(0, limits.lt)
      };
  }

  try {
      let url;
      let strategy;
      switch (source) {
          case 'api.uouin.com':
              url = _d([104,116,116,112,115,58,47,47,97,112,105,46,117,111,117,105,110,46,99,111,109,47,99,108,111,117,100,102,108,97,114,101,46,104,116,109,108]);
              strategy = ALL_STRATEGIES['phantomjs_cloud_interactive'];
              break;
          case 'wetest.vip':
              url = _d([104,116,116,112,115,58,47,47,119,119,119,46,119,101,116,101,115,116,46,118,105,112,47,112,97,103,101,47,99,108,111,117,100,102,108,97,114,101,47,97,100,100,114,101,115,115,95,118,52,46,104,116,109,108]);
              strategy = async (u) => {
                  const res = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
                  if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
                  return res.text();
              };
              break;
          case 'CloudFlareYes':
          default:
              url = _d([104,116,116,112,115,58,47,47,115,116,111,99,107,46,104,111,115,116,109,111,110,105,116,46,99,111,109,47,67,108,111,117,100,70,108,97,114,101,89,101,115]);
              strategy = ALL_STRATEGIES['phantomjs_cloud_interactive'];
              break;
      }
      
      const htmlContent = await strategy(url);
      return await parseHtmlTableWithOperator(htmlContent);

  } catch (e) {
    log(`从源 [${source}] 获取IP失败: ${e.message}`);
    return { yd: [], dx: [], lt: [] };
}
}

async function syncExternalSubscription(sub, db, log) {
  const { url } = sub;
  try {
      log(`Fetching external sub: ${url}`);
      const rawContent = await fetchAndParseExternalSubscription(url);

      if (rawContent !== null) {
          const nodeCount = rawContent.trim().split('\n').filter(Boolean).length;
          log(`Success: Found ${nodeCount} valid nodes.`);
          await db.prepare("INSERT INTO external_nodes (url, content, status, last_updated, error) VALUES (?, ?, 'success', CURRENT_TIMESTAMP, NULL) ON CONFLICT(url) DO UPDATE SET content=excluded.content, status='success', last_updated=CURRENT_TIMESTAMP, error=NULL")
              .bind(_e(url), rawContent).run();
      } else {
          throw new Error("No valid content returned from parser.");
      }
  } catch (e) {
      log(`Failed to fetch/parse sub ${url}: ${e.message}`);
      await db.prepare("INSERT INTO external_nodes (url, status, last_updated, error) VALUES (?, 'failed', CURRENT_TIMESTAMP, ?) ON CONFLICT(url) DO UPDATE SET status='failed', last_updated=CURRENT_TIMESTAMP, error=excluded.error")
          .bind(_e(url), e.message).run();
  }
}

function parseFilterRules(filters) {
if (!filters) return [];
return filters.split('\n').filter(Boolean).map(line => {
    line = line.trim();
    if (line.startsWith('#M:') || line.startsWith('#H:')) {
        const type = line.substring(0, 3);
        const ruleContent = line.substring(3);
        const parts = ruleContent.split('=');
        if (parts.length === 2) {
            const [match, replacement] = parts.map(s => s.trim());
            if (match) {
                return { type, match, replacement };
            }
        }
    } else if (line.startsWith('#T:') || line.startsWith('#W:')) {
        const type = line.substring(0, 3);
        const replacement = line.substring(3).trim();
        return { type, replacement };
    }
    return null;
}).filter(Boolean);
}

function applyContentFilters(content, filters) {
if (!filters) return content;

const rules = parseFilterRules(filters);
if (rules.length === 0) return content;

const lines = content.split('\n');
const processedLines = lines.map(line => {
    const parts = line.split('#');
    if (parts.length < 2) return line;

    let addressPort = parts[0];
    let remarks = parts.slice(1).join('#');
    const [address, port] = addressPort.split(':');
    let newAddress = address;

    for (const rule of rules) {
        switch(rule.type) {
            case '#H:':
                if (newAddress.includes(rule.match)) {
                    newAddress = newAddress.replace(new RegExp(rule.match, 'g'), rule.replacement);
                }
                break;
            case '#M:':
                if (remarks.includes(rule.match)) {
                    remarks = remarks.replace(new RegExp(rule.match, 'g'), rule.replacement);
                }
                break;
            case '#T:':
                remarks = rule.replacement + remarks;
                break;
            case '#W:':
                remarks = remarks + rule.replacement;
                break;
        }
    }
    return `${newAddress}:${port}#${remarks}`;
});

return processedLines.join('\n');
}

async function fetchAndParseExternalSubscription(url) {
if(!url) return null;
try {
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Cache-Control': 'no-cache' } });
    if (!response.ok) return null;
    
    let content = await response.text();

    if (content.trim().startsWith('<')) {
        const jsRegex = /copyURL\(\)\{navigator\.clipboard\.writeText\('([^']+)'\)/;
        const jsMatch = content.match(jsRegex);
        const subUrl = jsMatch ? jsMatch[1] : (content.match(/https:\/\/baidu\.sosorg\.nyc\.mn\/sub\?[^"'\s<]+/) || [])[0];

        if (subUrl) {
            const subResponse = await fetch(subUrl);
            if (!subResponse.ok) return null;
            content = await subResponse.text();
        } else {
            return null;
        }
    }

    try {
        const decoded = atob(content);
        if (decoded) content = decoded;
    } catch (e) { }
    
    return processSubscriptionContent(content.split('\n'));
} catch (error) {
    console.error(`处理外部订阅 ${url} 失败: ${error.message}`);
    return null;
}
}

function processSubscriptionContent(lines) {
const output = [];
const domainRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;
const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
const ipv6Regex = /(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))/i;

lines.forEach(line => {
    line = line.trim();
    if (!line) return;

    let nodeInfo = null;

    if (line.startsWith(_k(['vle','ss','://'])) || line.startsWith('vmess://')) {
        nodeInfo = parseShareLink(line);
    } else if (line.includes(':') && line.includes('#')) {
        const parts = line.split('#');
        if (parts.length >= 2) {
            const addressPort = parts[0];
            const originalRemarks = parts.slice(1).join('#');
            const [address, portStr] = addressPort.split(':');
            const port = parseInt(portStr, 10);
            nodeInfo = { address, port, remarks: originalRemarks };
        }
    }

    if (nodeInfo) {
        const { address, port, remarks } = nodeInfo;
        const isValidAddress = domainRegex.test(address) || ipv4Regex.test(address) || ipv6Regex.test(address);
        const isValidPort = !isNaN(port) && port > 0 && port < 65536;

        if (isValidAddress && isValidPort) {
            const newRemarks = formatRemarks(remarks, address);
            output.push(`${address}:${port}#${newRemarks}`);
        }
    }
});
return output.join('\n');
}

function formatRemarks(originalRemarks, address) {
const chineseRegex = /^[\u4e00-\u9fa5]/;
if (chineseRegex.test(originalRemarks.trim())) {
return address;
}
const letterRegex = /^[A-Za-z]{2,3}/;
const letterMatch = originalRemarks.trim().match(letterRegex);
if (letterMatch) {
return letterMatch[0];
}
return originalRemarks;
}

function parseShareLink(link) {
try {
    if (link.startsWith('vmess://')) {
        const decoded = JSON.parse(atob(link.substring(8)));
        const address = decoded.add;
        const port = parseInt(decoded.port, 10);
        const remarks = decoded.ps || decoded.add;
        return { address, port, remarks };
    } else {
        const url = new URL(link);
        const address = url.hostname;
        const port = parseInt(url.port, 10) || 443;
        const remarks = decodeURIComponent(url.hash.substring(1));
        return { address, port, remarks };
    }
} catch (e) {
    return null;
}
}

function parseExternalNodes(content, proxySettings, request) {
const lines = content.split('\n').filter(Boolean);
const requestHostname = new URL(request.url).hostname;
let sniHost = requestHostname;
if (proxySettings.useProxyUrlForSni) {
    try {
        sniHost = new URL(proxySettings.wsReverseProxyUrl).hostname;
    } catch (e) { }
}
const path = proxySettings.wsReverseProxyPath || '/';
const useRandomUuid = proxySettings.wsReverseProxyUseRandomUuid;
const specificUuid = proxySettings.wsReverseProxySpecificUuid;

return lines.map(line => {
    const parts = line.split('#');
    const addressPort = parts[0];
    const remarks = parts.slice(1).join('#');
    const [address, port] = addressPort.split(':');
    
    const uuid = useRandomUuid ? crypto.randomUUID() : specificUuid;
    const encodedPath = encodeURIComponent(encodeURIComponent(path));
    
    return `${_k(['vle','ss'])}://${uuid}@${address}:${port}?encryption=none&security=tls&sni=${sniHost}&fp=random&type=${_k(['w','s'])}&host=${sniHost}&path=${encodedPath}#${encodeURIComponent(remarks)}`;
});
}

function parseCustomNodes(content, proxySettings, request) {
if (!content) return [];
const lines = content.split('\n').filter(Boolean);
const requestHostname = new URL(request.url).hostname;
let sniHost = requestHostname;
if (proxySettings.useProxyUrlForSni && proxySettings.wsReverseProxyUrl) {
    try {
        sniHost = new URL(proxySettings.wsReverseProxyUrl).hostname;
    } catch (e) { }
}
const globalPath = proxySettings.wsReverseProxyPath || '/';
const useRandomUuid = proxySettings.wsReverseProxyUseRandomUuid;
const specificUuid = proxySettings.wsReverseProxySpecificUuid;

return lines.map(line => {
    const pathParts = line.split('@');
    const mainPart = pathParts[0];
    const customPath = pathParts.length > 1 ? pathParts[1] : null;

    const remarkParts = mainPart.split('#');
    const addressPort = remarkParts[0];
    const remarks = remarkParts.slice(1).join('#');
    const [address, port] = addressPort.split(':');
    
    const uuid = useRandomUuid ? crypto.randomUUID() : specificUuid;
    const finalPath = customPath ? `/${customPath.replace(/^\//, '')}` : globalPath;
    const encodedPath = encodeURIComponent(encodeURIComponent(finalPath));
    
    return `${_k(['vle','ss'])}://${uuid}@${address}:${port}?encryption=none&security=tls&sni=${sniHost}&fp=random&type=${_k(['w','s'])}&host=${sniHost}&path=${encodedPath}#${encodeURIComponent(remarks)}`;
});
}

async function syncAllIpSourcesToD1(env, log) {
    const db = env.WUYA;
    const { results: sources } = await db.prepare(
        "SELECT * FROM ip_sources WHERE is_enabled = 1"
    ).all();

    if (sources.length === 0) {
        log("IP Source Sync: No sources to process.");
        return 0;
    }

    log(`IP Source Sync: Found ${sources.length} sources to process.`);
    let processedCount = 0;
    for (const source of sources) {
        try {
          await syncSingleIpSourceToD1(source.id, env, log);
          processedCount++;
      } catch (e) {
          log(`IP Source Sync: Error processing source ID ${source.id}: ${e.message}`);
      }
  }
  return processedCount;
}
