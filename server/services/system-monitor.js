/**
 * System Monitor Service
 * Provides system resource information for the dashboard
 * Uses the 'systeminformation' library
 */

const si = require('systeminformation');

// Cache configuration to prevent excessive system calls
let cachedStatus = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 2000; // 2 second cache

/**
 * Get listening ports with associated process information
 * @returns {Promise<Array>} Array of port info objects
 */
async function getListeningPorts() {
    try {
        const connections = await si.networkConnections();
        
        // Filter for listening connections on user-space ports (>= 1024)
        const listeningPorts = connections
            .filter(conn => 
                conn.state === 'LISTEN' && 
                parseInt(conn.localPort, 10) >= 1024
            )
            .map(conn => ({
                port: parseInt(conn.localPort, 10) || conn.localPort,
                pid: conn.pid,
                process: conn.process || 'unknown',
                address: conn.localAddress || '0.0.0.0',
                protocol: conn.protocol || 'tcp'
            }));
        
        // Deduplicate by port (keep first occurrence)
        const uniquePorts = [];
        const seenPorts = new Set();
        for (const port of listeningPorts) {
            if (!seenPorts.has(port.port)) {
                seenPorts.add(port.port);
                uniquePorts.push(port);
            }
        }
        
        // Sort by port number
        return uniquePorts.sort((a, b) => a.port - b.port);
    } catch (error) {
        console.error('[SystemMonitor] Error getting listening ports:', error);
        return [];
    }
}

/**
 * Get basic system info (CPU, memory usage)
 * @returns {Promise<Object>} System info object
 */
async function getBasicSystemInfo() {
    try {
        const [currentLoad, mem] = await Promise.all([
            si.currentLoad(),
            si.mem()
        ]);
        
        return {
            cpu: {
                usage: Math.round(currentLoad.currentLoad),
                cores: currentLoad.cpus?.length || 0
            },
            memory: {
                total: mem.total,
                used: mem.used,
                free: mem.free,
                usagePercent: Math.round((mem.used / mem.total) * 100)
            }
        };
    } catch (error) {
        console.error('[SystemMonitor] Error getting system info:', error);
        return {
            cpu: { usage: 0, cores: 0 },
            memory: { total: 0, used: 0, free: 0, usagePercent: 0 }
        };
    }
}

/**
 * Get complete system status (cached)
 * @param {boolean} forceRefresh - Bypass cache
 * @returns {Promise<Object>} Full system status
 */
async function getSystemStatus(forceRefresh = false) {
    const now = Date.now();
    
    // Return cached data if still fresh
    if (!forceRefresh && cachedStatus && (now - cacheTimestamp) < CACHE_TTL_MS) {
        return cachedStatus;
    }
    
    try {
        // Wrap system calls with a timeout to prevent hanging
        // (systeminformation uses sysctl which may not be on LaunchAgent PATH)
        const withTimeout = (promise, ms = 3000) => {
            let timer;
            return Promise.race([
                promise,
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error('System info timed out')), ms);
                })
            ]).finally(() => clearTimeout(timer));
        };

        let ports = [];
        let systemInfo = { cpu: { usage: 0, cores: 0 }, memory: { total: 0, used: 0, free: 0, usagePercent: 0 } };

        try {
            [ports, systemInfo] = await Promise.all([
                withTimeout(getListeningPorts()),
                withTimeout(getBasicSystemInfo())
            ]);
        } catch (sysErr) {
            console.warn('[SystemMonitor] System info collection timed out or failed:', sysErr.message);
        }
        
        // Identify common dev server ports
        const knownDevPorts = {
            3000: 'Next.js/React',
            3001: 'Next.js (alt)',
            4000: 'Express/API',
            5000: 'Flask/Vite',
            5173: 'Vite',
            5174: 'Vite (alt)',
            8000: 'Django/FastAPI',
            8080: 'Generic HTTP',
            8081: 'Generic HTTP (alt)',
            9000: 'PHP/Generic',
            27017: 'MongoDB',
            5432: 'PostgreSQL',
            3306: 'MySQL',
            6379: 'Redis'
        };
        
        // Enrich port data with type hints
        const enrichedPorts = ports.map(p => ({
            ...p,
            hint: knownDevPorts[p.port] || null,
            type: p.process?.toLowerCase().includes('node') ? 'node' :
                  p.process?.toLowerCase().includes('python') ? 'python' :
                  p.process?.toLowerCase().includes('java') ? 'java' :
                  'other'
        }));
        
        // Fetch Praxis statistics using http module
        let praxisStats = null;
        try {
            console.log('[SystemMonitor] Fetching Praxis stats...');
            const http = require('http');
            praxisStats = await new Promise((resolve) => {
                const req = http.get('http://127.0.0.1:54322/api/praxis/stats', (res) => {
                    if (res.statusCode !== 200) {
                        console.error(`[SystemMonitor] Praxis API returned ${res.statusCode}`);
                        resolve(null);
                        return;
                    }
                    let data = '';
                    res.on('data', (chunk) => { data += chunk; });
                    res.on('end', () => {
                        try {
                            const parsed = JSON.parse(data);
                            console.log('[SystemMonitor] Praxis stats fetched successfully:', parsed);
                            resolve(parsed);
                        } catch (e) {
                            console.error('[SystemMonitor] Error parsing Praxis stats JSON', e.message);
                            resolve(null);
                        }
                    });
                });
                req.on('error', (err) => {
                    console.error('[SystemMonitor] Error fetching Praxis stats:', err.message);
                    resolve(null);
                });
                req.setTimeout(3000, () => {
                    req.destroy();
                    resolve(null);
                });
            });
        } catch (err) {
            console.error('[SystemMonitor] Exception fetching Praxis stats:', err.stack);
        }

        cachedStatus = {
            timestamp: new Date().toISOString(),
            system: systemInfo,
            ports: enrichedPorts,
            portCount: enrichedPorts.length,
            praxis: praxisStats
        };
        cacheTimestamp = now;
        
        return cachedStatus;
    } catch (error) {
        console.error('[SystemMonitor] Error getting system status:', error);
        return {
            timestamp: new Date().toISOString(),
            system: { cpu: { usage: 0 }, memory: { usagePercent: 0 } },
            ports: [],
            portCount: 0,
            error: error.message
        };
    }
}

/**
 * Clear the cache (useful after expected system changes)
 */
function clearCache() {
    cachedStatus = null;
    cacheTimestamp = 0;
}

module.exports = {
    getSystemStatus,
    getListeningPorts,
    getBasicSystemInfo,
    clearCache
};
