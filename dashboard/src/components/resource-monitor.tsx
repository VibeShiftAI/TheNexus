'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { 
    Activity, 
    Cpu, 
    HardDrive, 
    Server, 
    Wifi,
    Coins,
    TrendingUp,
    RefreshCw,
    ChevronDown,
    ChevronUp,
    AlertTriangle,
    Terminal,
    XCircle
} from 'lucide-react';
import { getSystemStatus, getUsageStats, SystemStatus, UsageStats } from '../lib/nexus';

interface ResourceMonitorProps {
    className?: string;
    onClose?: () => void;
}

export function ResourceMonitor({ className = '', onClose }: ResourceMonitorProps) {
    const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
    const [usageStats, setUsageStats] = useState<UsageStats | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isExpanded, setIsExpanded] = useState(true);
    const [activeTab, setActiveTab] = useState<'ports' | 'tokens'>('ports');
    const [retryCount, setRetryCount] = useState(0);
    
    const fetchData = useCallback(async () => {
        setIsLoading(true);
        try {
            const [status, stats] = await Promise.all([
                getSystemStatus(),
                getUsageStats({ days: 7 })
            ]);
            setSystemStatus(status);
            setUsageStats(stats);
            setError(null);
            setRetryCount(0);
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : 'Failed to fetch data';
            setError(errorMsg);
            // Don't clear previous data on error - keep showing stale data
        } finally {
            setIsLoading(false);
        }
    }, []);
    
    // Initial fetch and polling
    useEffect(() => {
        fetchData();
        // Only poll if we have a successful connection
        const interval = setInterval(() => {
            if (!error) {
                fetchData();
            }
        }, 5000); // Poll every 5 seconds
        return () => clearInterval(interval);
    }, [fetchData, error]);
    
    const handleRetry = useCallback(() => {
        setRetryCount(prev => prev + 1);
        fetchData();
    }, [fetchData]);
    
    const formatBytes = (bytes: number): string => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    };
    
    const formatNumber = (num: number): string => {
        if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M';
        if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
        return num.toString();
    };
    
    const formatCost = (cost: number): string => {
        return '$' + cost.toFixed(4);
    };

    // Check if error is a server restart needed error
    const isServerRestartNeeded = error && (error.includes('404') || error.includes('Failed to get'));
    
    return (
        <div className={`bg-slate-900/50 border border-slate-800 rounded-xl ${className}`}>
            {/* Header */}
            <div 
                className="flex items-center justify-between p-4 cursor-pointer hover:bg-slate-800/30 transition-colors"
                onClick={() => setIsExpanded(!isExpanded)}
            >
                <div className="flex items-center gap-3">
                    <Activity className={`w-5 h-5 ${error ? 'text-amber-400' : 'text-cyan-400'}`} />
                    <h3 className="font-semibold text-white">Resource Monitor</h3>
                    {!error && systemStatus && (
                        <span className="text-xs text-slate-400">
                            {systemStatus.portCount} active ports
                        </span>
                    )}
                    {error && (
                        <span className="text-xs text-amber-400 flex items-center gap-1">
                            <AlertTriangle className="w-3 h-3" />
                            Setup required
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            handleRetry();
                        }}
                        className="p-1 hover:bg-slate-700 rounded transition-colors"
                        title="Refresh"
                    >
                        <RefreshCw className={`w-4 h-4 text-slate-400 ${isLoading ? 'animate-spin' : ''}`} />
                    </button>
                    {onClose && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onClose();
                            }}
                            className="p-1 hover:bg-slate-700 rounded transition-colors"
                            title="Close"
                        >
                            <XCircle className="w-4 h-4 text-slate-400" />
                        </button>
                    )}
                    {isExpanded ? (
                        <ChevronUp className="w-5 h-5 text-slate-400" />
                    ) : (
                        <ChevronDown className="w-5 h-5 text-slate-400" />
                    )}
                </div>
            </div>
            
            {isExpanded && (
                <div className="px-4 pb-4">
                    {/* Error State - Server Restart Needed */}
                    {isServerRestartNeeded && (
                        <div className="mb-4 p-4 bg-amber-500/10 border border-amber-500/20 rounded-lg">
                            <div className="flex items-start gap-3">
                                <Terminal className="w-5 h-5 text-amber-400 mt-0.5 flex-shrink-0" />
                                <div className="flex-1">
                                    <div className="font-medium text-amber-400 mb-2">Server Restart Required</div>
                                    <p className="text-sm text-amber-300/80 mb-3">
                                        The resource monitoring feature was recently added to TheNexus. Your running server needs to be restarted to enable these new endpoints.
                                    </p>
                                    <div className="bg-slate-900/50 rounded-lg p-3 font-mono text-xs">
                                        <div className="text-slate-400 mb-1"># In your terminal, run:</div>
                                        <div className="text-cyan-400">cd path/to/TheNexus</div>
                                        <div className="text-slate-500"># Stop the current server (Ctrl+C), then:</div>
                                        <div className="text-green-400">npm run dev</div>
                                    </div>
                                    <button
                                        onClick={handleRetry}
                                        className="mt-3 px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 rounded-lg text-sm transition-colors flex items-center gap-2"
                                    >
                                        <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
                                        Check Again {retryCount > 0 && `(${retryCount})`}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Error State - Connection Error */}
                    {error && !isServerRestartNeeded && (
                        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
                            <div className="font-medium mb-1">Connection Error</div>
                            <p className="text-xs text-red-300/80">{error}</p>
                            <button
                                onClick={handleRetry}
                                className="mt-2 px-2 py-1 bg-red-500/20 hover:bg-red-500/30 rounded text-xs transition-colors"
                            >
                                Retry
                            </button>
                        </div>
                    )}
                    
                    {/* Loading Skeleton - only show on initial load */}
                    {isLoading && !systemStatus && !error && (
                        <div className="space-y-4 animate-pulse">
                            <div className="grid grid-cols-2 gap-3">
                                <div className="h-14 bg-slate-800/50 rounded-lg" />
                                <div className="h-14 bg-slate-800/50 rounded-lg" />
                            </div>
                            <div className="flex gap-2">
                                <div className="h-8 w-20 bg-slate-800/50 rounded-lg" />
                                <div className="h-8 w-28 bg-slate-800/50 rounded-lg" />
                            </div>
                            <div className="space-y-2">
                                <div className="h-12 bg-slate-800/30 rounded-lg" />
                                <div className="h-12 bg-slate-800/30 rounded-lg" />
                            </div>
                        </div>
                    )}
                    
                    {/* System Stats Bar */}
                    {systemStatus && (
                        <div className="grid grid-cols-2 gap-3 mb-4">
                            <div className="flex items-center gap-2 p-2 bg-slate-800/50 rounded-lg">
                                <Cpu className="w-4 h-4 text-blue-400" />
                                <span className="text-xs text-slate-400">CPU</span>
                                <span className="text-sm font-medium text-white ml-auto">
                                    {systemStatus.system.cpu.usage}%
                                </span>
                            </div>
                            <div className="flex items-center gap-2 p-2 bg-slate-800/50 rounded-lg">
                                <HardDrive className="w-4 h-4 text-purple-400" />
                                <span className="text-xs text-slate-400">RAM</span>
                                <span className="text-sm font-medium text-white ml-auto">
                                    {systemStatus.system.memory.usagePercent}%
                                </span>
                            </div>
                        </div>
                    )}
                    
                    {/* Only show tabs and content when we have data or no error */}
                    {(systemStatus || usageStats) && (
                        <>
                            {/* Tab Switcher */}
                            <div className="flex gap-2 mb-4">
                                <button
                                    onClick={() => setActiveTab('ports')}
                                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                                        activeTab === 'ports' 
                                            ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30' 
                                            : 'text-slate-400 hover:text-white hover:bg-slate-800'
                                    }`}
                                >
                                    <Server className="w-4 h-4" />
                                    Ports
                                </button>
                                <button
                                    onClick={() => setActiveTab('tokens')}
                                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                                        activeTab === 'tokens' 
                                            ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30' 
                                            : 'text-slate-400 hover:text-white hover:bg-slate-800'
                                    }`}
                                >
                                    <Coins className="w-4 h-4" />
                                    Token Usage
                                </button>
                            </div>
                            
                            {/* Ports Tab */}
                            {activeTab === 'ports' && (
                                <div className="space-y-2">
                                    {systemStatus && systemStatus.ports.length > 0 ? (
                                        systemStatus.ports.map((port, index) => (
                                            <div 
                                                key={`${port.port}-${index}`}
                                                className="flex items-center justify-between p-2 bg-slate-800/30 rounded-lg"
                                            >
                                                <div className="flex items-center gap-3">
                                                    <div className={`w-2 h-2 rounded-full ${
                                                        port.type === 'node' ? 'bg-green-400' :
                                                        port.type === 'python' ? 'bg-yellow-400' :
                                                        port.type === 'java' ? 'bg-orange-400' :
                                                        'bg-slate-400'
                                                    }`} />
                                                    <span className="text-white font-mono text-sm">:{port.port}</span>
                                                    {port.hint && (
                                                        <span className="text-xs text-slate-500">{port.hint}</span>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <span className="text-xs text-slate-400 truncate max-w-[100px]">
                                                        {port.process}
                                                    </span>
                                                    <span className="text-xs text-slate-500">
                                                        PID: {port.pid}
                                                    </span>
                                                </div>
                                            </div>
                                        ))
                                    ) : systemStatus ? (
                                        <div className="text-center py-8 text-slate-500 text-sm">
                                            <Server className="w-8 h-8 mx-auto mb-2 opacity-50" />
                                            No active development servers detected
                                        </div>
                                    ) : null}
                                </div>
                            )}
                            
                            {/* Token Usage Tab */}
                            {activeTab === 'tokens' && (
                                <div className="space-y-4">
                                    {usageStats ? (
                                        <>
                                            {/* Summary Stats */}
                                            <div className="grid grid-cols-2 gap-3">
                                                <div className="p-3 bg-slate-800/30 rounded-lg">
                                                    <div className="flex items-center gap-2 mb-1">
                                                        <TrendingUp className="w-4 h-4 text-cyan-400" />
                                                        <span className="text-xs text-slate-400">Total Tokens</span>
                                                    </div>
                                                    <span className="text-lg font-semibold text-white">
                                                        {formatNumber(usageStats.totals.totalTokens)}
                                                    </span>
                                                </div>
                                                <div className="p-3 bg-slate-800/30 rounded-lg">
                                                    <div className="flex items-center gap-2 mb-1">
                                                        <Coins className="w-4 h-4 text-amber-400" />
                                                        <span className="text-xs text-slate-400">Est. Cost</span>
                                                    </div>
                                                    <span className="text-lg font-semibold text-white">
                                                        {formatCost(usageStats.totals.estimatedCostUSD)}
                                                    </span>
                                                </div>
                                            </div>
                                            
                                            {/* By Provider */}
                                            <div>
                                                <h4 className="text-xs text-slate-500 uppercase tracking-wide mb-2">By Provider</h4>
                                                <div className="space-y-2">
                                                    {Object.entries(usageStats.byProvider).length > 0 ? (
                                                        Object.entries(usageStats.byProvider).map(([provider, data]) => (
                                                            <div 
                                                                key={provider}
                                                                className="flex items-center justify-between p-2 bg-slate-800/30 rounded-lg"
                                                            >
                                                                <div className="flex items-center gap-2">
                                                                    <span className={`w-2 h-2 rounded-full ${
                                                                        provider === 'google' ? 'bg-blue-400' :
                                                                        provider === 'anthropic' ? 'bg-amber-400' :
                                                                        provider === 'openai' ? 'bg-green-400' :
                                                                        'bg-slate-400'
                                                                    }`} />
                                                                    <span className="text-sm text-white capitalize">{provider}</span>
                                                                </div>
                                                                <div className="flex items-center gap-4 text-xs">
                                                                    <span className="text-slate-400">
                                                                        {formatNumber(data.totalTokens)} tokens
                                                                    </span>
                                                                    <span className="text-amber-400">
                                                                        {formatCost(data.cost)}
                                                                    </span>
                                                                </div>
                                                            </div>
                                                        ))
                                                    ) : (
                                                        <div className="text-center py-4 text-slate-500 text-sm">
                                                            No usage recorded yet
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                            
                                            {/* Recent Activity */}
                                            {usageStats.recentUsage.length > 0 && (
                                                <div>
                                                    <h4 className="text-xs text-slate-500 uppercase tracking-wide mb-2">Recent Activity</h4>
                                                    <div className="space-y-1 max-h-40 overflow-y-auto">
                                                        {usageStats.recentUsage.slice(0, 10).map((entry, index) => (
                                                            <div 
                                                                key={`${entry.timestamp}-${index}`}
                                                                className="flex items-center justify-between p-2 bg-slate-800/20 rounded text-xs"
                                                            >
                                                                <div className="flex items-center gap-2">
                                                                    <span className="text-slate-500">
                                                                        {new Date(entry.timestamp).toLocaleTimeString()}
                                                                    </span>
                                                                    <span className="text-slate-400 capitalize">
                                                                        {entry.provider}
                                                                    </span>
                                                                </div>
                                                                <div className="flex items-center gap-2">
                                                                    <span className="text-slate-400">
                                                                        {formatNumber(entry.totalTokens)}
                                                                    </span>
                                                                    <span className="text-amber-400">
                                                                        {formatCost(entry.cost)}
                                                                    </span>
                                                                </div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                        </>
                                    ) : (
                                        <div className="text-center py-8 text-slate-500 text-sm">
                                            <Coins className="w-8 h-8 mx-auto mb-2 opacity-50" />
                                            No token usage data available
                                        </div>
                                    )}
                                </div>
                            )}
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
