"use client";

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
    AlertTriangle,
    Terminal,
    Search,
    Filter,
    Zap,
    Brain,
    Clock,
    ArrowLeft,
    ShieldCheck
} from 'lucide-react';
import Link from 'next/link';
import {
    AreaChart,
    Area,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    PieChart,
    Pie,
    Cell,
    BarChart,
    Bar,
    Legend
} from 'recharts';
import { getSystemStatus, getUsageStats, SystemStatus, UsageStats, PortInfo } from '../../lib/nexus';

// Colors for charts
const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8', '#82ca9d'];
const PROVIDER_COLORS: Record<string, string> = {
    'google': '#3b82f6', // blue-500
    'anthropic': '#f59e0b', // amber-500
    'openai': '#22c55e', // green-500
    'other': '#94a3b8' // slate-400
};

export default function SystemMonitorPage() {
    const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
    const [usageStats, setUsageStats] = useState<UsageStats | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [retryCount, setRetryCount] = useState(0);
    const [showAllPorts, setShowAllPorts] = useState(false);

    const fetchData = useCallback(async () => {
        setIsLoading(true);
        try {
            const [status, stats] = await Promise.all([
                getSystemStatus(),
                getUsageStats({ days: 30 }) // Get last 30 days for better graphs
            ]);
            setSystemStatus(status);
            setUsageStats(stats);
            setError(null);
            setRetryCount(0);
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : 'Failed to fetch data';
            setError(errorMsg);
        } finally {
            setIsLoading(false);
        }
    }, []);

    // Initial fetch and polling
    useEffect(() => {
        fetchData();
        const interval = setInterval(() => {
            if (!error) {
                // Background update without setting loading state
                Promise.all([
                    getSystemStatus(),
                    getUsageStats({ days: 30 })
                ]).then(([status, stats]) => {
                    setSystemStatus(status);
                    setUsageStats(stats);
                }).catch(console.error);
            }
        }, 5000); // Poll every 5 seconds
        return () => clearInterval(interval);
    }, [fetchData, error]);

    const handleRetry = () => {
        setRetryCount(prev => prev + 1);
        fetchData();
    };

    // Formatters
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

    // Prepare chart data
    const getUsageByDay = () => {
        if (!usageStats) return [];

        // Group recent usage by day
        const dailyUsage: Record<string, { date: string; tokens: number; cost: number }> = {};

        // Initialize last 7 days with 0
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dateStr = d.toLocaleDateString();
            dailyUsage[dateStr] = { date: dateStr, tokens: 0, cost: 0 };
        }

        // Use recent usage which usually has granular data
        // For a real production app, we'd want an endpoint that returns aggregated daily stats
        // But for now we'll approximate from recent usage if available, or just show totals
        // Actually, let's just use the recentUsage array and group it

        (usageStats.recentUsage || []).forEach(entry => {
            const dateStr = new Date(entry.timestamp).toLocaleDateString();
            if (!dailyUsage[dateStr]) {
                dailyUsage[dateStr] = { date: dateStr, tokens: 0, cost: 0 };
            }
            dailyUsage[dateStr].tokens += entry.totalTokens;
            dailyUsage[dateStr].cost += entry.cost;
        });

        return Object.values(dailyUsage).sort((a, b) =>
            new Date(a.date).getTime() - new Date(b.date).getTime()
        );
    };

    const getProviderData = () => {
        if (!usageStats) return [];
        return Object.entries(usageStats.byProvider || {}).map(([name, data]) => ({
            name,
            value: data.totalTokens,
            cost: data.cost
        }));
    };

    // Filter ports
    const filteredPorts = (systemStatus?.ports || []).filter(port => {
        if (showAllPorts) return true;
        // Show known dev stats
        return ['node', 'python', 'java'].includes(port.type) ||
            // Or show interesting ports
            [3000, 8000, 8080, 5173, 4200].includes(port.port);
    }) || [];

    if (isLoading && !systemStatus) {
        return (
            <div className="flex items-center justify-center min-h-screen text-cyan-400">
                <RefreshCw className="w-8 h-8 animate-spin" />
            </div>
        );
    }

    if (error && !systemStatus) {
        return (
            <div className="p-8 max-w-2xl mx-auto mt-10 text-center">
                <div className="inline-flex p-4 bg-red-500/10 rounded-full mb-4">
                    <AlertTriangle className="w-12 h-12 text-red-400" />
                </div>
                <h2 className="text-2xl font-bold text-white mb-2">Connection Failed</h2>
                <p className="text-slate-400 mb-6">{error}</p>
                <button
                    onClick={handleRetry}
                    className="px-4 py-2 bg-cyan-500 hover:bg-cyan-600 text-white rounded-lg transition-colors flex items-center gap-2 mx-auto"
                >
                    <RefreshCw className="w-4 h-4" />
                    Retry Connection
                </button>
            </div>
        );
    }

    return (
        <main className="min-h-screen bg-slate-950 text-slate-200 selection:bg-cyan-500/30">
            {/* Header HUD */}
            <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/80 backdrop-blur-md">
                <div className="container mx-auto flex h-16 items-center justify-between px-6">
                    <div className="flex items-center gap-4">
                        <Link
                            href="/"
                            className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors"
                        >
                            <ArrowLeft size={18} />
                            <span className="text-sm">Dashboard</span>
                        </Link>
                        <div className="h-6 w-px bg-slate-700" />
                        <div className="flex items-center gap-2">
                            <div className="h-2 w-2 rounded-full bg-cyan-500 animate-pulse" />
                            <h1 className="text-xl font-bold tracking-tight text-white">
                                THE <span className="text-cyan-400">NEXUS</span>
                            </h1>
                        </div>
                    </div>
                    <div className="flex items-center gap-6 text-sm font-medium text-slate-400">
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/20 border border-amber-500/30 text-amber-400">
                            <Activity size={16} />
                            <span>System Monitor</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <ShieldCheck size={16} className="text-emerald-500" />
                            <span>TUNNEL ACTIVE</span>
                        </div>
                        <div className="flex items-center gap-2">
                            <Zap size={16} className="text-yellow-500" />
                            <span>VIBE: HIGH</span>
                        </div>
                    </div>
                </div>
            </header>

            <div className="container mx-auto p-6 space-y-6">
                {/* Page Header */}
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-2xl font-bold text-white flex items-center gap-3">
                            <Activity className="text-cyan-400" />
                            System Monitor
                        </h1>
                        <p className="text-slate-400 mt-1">
                            Real-time system metrics and AI token tracking
                        </p>
                    </div>
                    <div className="flex items-center gap-3">
                        <div className="text-xs text-slate-500">
                            Updated: {new Date().toLocaleTimeString()}
                        </div>
                        <button
                            onClick={() => fetchData()}
                            className="p-2 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition-colors"
                            title="Refresh Data"
                        >
                            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
                        </button>
                    </div>
                </div>

                {/* Key Metrics Row */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                    {/* CPU & Memory */}
                    <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4">
                        <div className="flex items-start justify-between mb-4">
                            <div>
                                <p className="text-xs text-slate-400 uppercase tracking-wide">System Load</p>
                                <h3 className="text-xl font-bold text-white mt-1">
                                    {systemStatus?.system?.cpu?.usage}% CPU
                                </h3>
                            </div>
                            <div className="p-2 bg-blue-500/10 rounded-lg">
                                <Cpu className="w-5 h-5 text-blue-400" />
                            </div>
                        </div>
                        <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden mb-2">
                            <div
                                className="bg-blue-500 h-full transition-all duration-500"
                                style={{ width: `${systemStatus?.system?.cpu?.usage}%` }}
                            />
                        </div>
                        <div className="flex justify-between text-xs text-slate-500">
                            <span>RAM: {systemStatus?.system?.memory?.usagePercent}%</span>
                            <span>{formatBytes(systemStatus?.system?.memory?.used || 0)} / {formatBytes(systemStatus?.system?.memory?.total || 0)}</span>
                        </div>
                    </div>

                    {/* Total Tokens */}
                    <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4">
                        <div className="flex items-start justify-between mb-4">
                            <div>
                                <p className="text-xs text-slate-400 uppercase tracking-wide">Total Tokens</p>
                                <h3 className="text-xl font-bold text-white mt-1">
                                    {formatNumber(usageStats?.totals?.totalTokens || 0)}
                                </h3>
                            </div>
                            <div className="p-2 bg-purple-500/10 rounded-lg">
                                <Brain className="w-5 h-5 text-purple-400" />
                            </div>
                        </div>
                        <div className="flex items-center gap-2 text-xs">
                            <span className="text-emerald-400 font-medium flex items-center">
                                <TrendingUp className="w-3 h-3 mr-1" />
                                Active
                            </span>
                            <span className="text-slate-500">Lifetime usage</span>
                        </div>
                    </div>

                    {/* Estimated Cost */}
                    <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4">
                        <div className="flex items-start justify-between mb-4">
                            <div>
                                <p className="text-xs text-slate-400 uppercase tracking-wide">Est. Cost</p>
                                <h3 className="text-xl font-bold text-white mt-1">
                                    {formatCost(usageStats?.totals?.estimatedCostUSD || 0)}
                                </h3>
                            </div>
                            <div className="p-2 bg-amber-500/10 rounded-lg">
                                <Coins className="w-5 h-5 text-amber-400" />
                            </div>
                        </div>
                        <div className="text-xs text-slate-500">
                            Based on current model pricing
                        </div>
                    </div>

                    {/* Active Ports */}
                    <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4">
                        <div className="flex items-start justify-between mb-4">
                            <div>
                                <p className="text-xs text-slate-400 uppercase tracking-wide">Active Ports</p>
                                <h3 className="text-xl font-bold text-white mt-1">
                                    {systemStatus?.portCount || 0}
                                </h3>
                            </div>
                            <div className="p-2 bg-emerald-500/10 rounded-lg">
                                <Server className="w-5 h-5 text-emerald-400" />
                            </div>
                        </div>
                        <div className="text-xs text-slate-500">
                            {filteredPorts.length} relevant dev servers
                        </div>
                    </div>
                </div>

                {/* Graphs Row */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    {/* Main Usage Graph */}
                    <div className="lg:col-span-2 bg-slate-900/50 border border-slate-800 rounded-xl p-6">
                        <h3 className="text-lg font-semibold text-white mb-6">Token Usage History</h3>
                        <div className="h-[300px] w-full">
                            <ResponsiveContainer width="100%" height="100%">
                                <AreaChart data={getUsageByDay()}>
                                    <defs>
                                        <linearGradient id="colorTokens" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="#8884d8" stopOpacity={0.8} />
                                            <stop offset="95%" stopColor="#8884d8" stopOpacity={0} />
                                        </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                                    <XAxis
                                        dataKey="date"
                                        stroke="#94a3b8"
                                        fontSize={12}
                                        tickLine={false}
                                        axisLine={false}
                                    />
                                    <YAxis
                                        stroke="#94a3b8"
                                        fontSize={12}
                                        tickLine={false}
                                        axisLine={false}
                                        tickFormatter={(value) => formatNumber(value)}
                                    />
                                    <Tooltip
                                        contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', color: '#fff' }}
                                        itemStyle={{ color: '#fff' }}
                                        labelStyle={{ color: '#94a3b8' }}
                                    />
                                    <Area
                                        type="monotone"
                                        dataKey="tokens"
                                        stroke="#8884d8"
                                        fillOpacity={1}
                                        fill="url(#colorTokens)"
                                    />
                                </AreaChart>
                            </ResponsiveContainer>
                        </div>
                    </div>

                    {/* Provider Breakdown */}
                    <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-6">
                        <h3 className="text-lg font-semibold text-white mb-6">Provider Distribution</h3>
                        <div className="h-[300px]">
                            <ResponsiveContainer width="100%" height="100%">
                                <PieChart>
                                    <Pie
                                        data={getProviderData()}
                                        innerRadius={60}
                                        outerRadius={80}
                                        paddingAngle={5}
                                        dataKey="value"
                                    >
                                        {getProviderData().map((entry, index) => (
                                            <Cell
                                                key={`cell-${index}`}
                                                fill={PROVIDER_COLORS[entry.name.toLowerCase()] || PROVIDER_COLORS['other']}
                                            />
                                        ))}
                                    </Pie>
                                    <Tooltip
                                        contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', color: '#fff' }}
                                    />
                                    <Legend />
                                </PieChart>
                            </ResponsiveContainer>
                        </div>
                    </div>
                </div>

                {/* Bottom Details Row */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* Port Manager */}
                    <div className="bg-slate-900/50 border border-slate-800 rounded-xl overflow-hidden">
                        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
                            <h3 className="font-semibold text-white flex items-center gap-2">
                                <Server className="w-4 h-4 text-cyan-400" />
                                Active Ports
                            </h3>
                            <div className="flex items-center gap-2">
                                <span className="text-xs text-slate-400">Show all</span>
                                <button
                                    onClick={() => setShowAllPorts(!showAllPorts)}
                                    className={`w-8 h-4 rounded-full transition-colors relative ${showAllPorts ? 'bg-cyan-500' : 'bg-slate-700'}`}
                                >
                                    <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${showAllPorts ? 'left-4.5' : 'left-0.5'}`} />
                                </button>
                            </div>
                        </div>
                        <div className="divide-y divide-slate-800/50 max-h-[400px] overflow-y-auto">
                            {filteredPorts.length > 0 ? (
                                filteredPorts.map((port, i) => (
                                    <div key={i} className="p-4 hover:bg-slate-800/30 transition-colors">
                                        <div className="flex items-center justify-between mb-1">
                                            <div className="flex items-center gap-3">
                                                <span className="font-mono text-cyan-400 font-bold">:{port.port}</span>
                                                <span className={`text-xs px-2 py-0.5 rounded-full ${port.type === 'node' ? 'bg-green-500/20 text-green-400' :
                                                    port.type === 'python' ? 'bg-yellow-500/20 text-yellow-400' :
                                                        'bg-slate-500/20 text-slate-400'
                                                    }`}>
                                                    {port.type}
                                                </span>
                                            </div>
                                            <span className="text-xs text-slate-500 font-mono">PID: {port.pid}</span>
                                        </div>
                                        <div className="flex items-center justify-between">
                                            <div className="text-sm text-slate-300 truncate max-w-[300px]" title={port.process}>
                                                {port.process}
                                            </div>
                                            {port.hint && (
                                                <span className="text-xs text-purple-400/80 italic">
                                                    {port.hint}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                ))
                            ) : (
                                <div className="p-8 text-center text-slate-500">
                                    <Server className="w-8 h-8 mx-auto mb-2 opacity-20" />
                                    <p>No active development ports found</p>
                                    {!showAllPorts && (
                                        <button
                                            onClick={() => setShowAllPorts(true)}
                                            className="text-xs text-cyan-400 hover:text-cyan-300 mt-2"
                                        >
                                            Show system ports
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Recent Activity */}
                    <div className="bg-slate-900/50 border border-slate-800 rounded-xl overflow-hidden">
                        <div className="p-4 border-b border-slate-800">
                            <h3 className="font-semibold text-white flex items-center gap-2">
                                <Clock className="w-4 h-4 text-amber-400" />
                                Recent Token Activity
                            </h3>
                        </div>
                        <div className="divide-y divide-slate-800/50 max-h-[400px] overflow-y-auto">
                            {usageStats?.recentUsage && usageStats.recentUsage.length > 0 ? (
                                usageStats.recentUsage.map((entry, i) => (
                                    <div key={i} className="p-4 hover:bg-slate-800/30 transition-colors">
                                        <div className="flex items-center justify-between mb-2">
                                            <div className="flex items-center gap-2">
                                                <span className={`w-2 h-2 rounded-full ${PROVIDER_COLORS[entry.provider.toLowerCase()] || PROVIDER_COLORS['other']
                                                    }`} />
                                                <span className="text-sm font-medium text-white capitalize">
                                                    {entry.provider}
                                                </span>
                                                <span className="text-xs text-slate-500">
                                                    {entry.model}
                                                </span>
                                            </div>
                                            <span className="text-xs text-slate-400">
                                                {new Date(entry.timestamp).toLocaleString()}
                                            </span>
                                        </div>
                                        <div className="flex items-center justify-between text-xs">
                                            <div className="flex gap-3">
                                                <span className="text-slate-400">
                                                    Input: <span className="text-slate-300">{entry.inputTokens}</span>
                                                </span>
                                                <span className="text-slate-400">
                                                    Output: <span className="text-slate-300">{entry.outputTokens}</span>
                                                </span>
                                            </div>
                                            <div className="font-mono text-amber-400">
                                                {formatCost(entry.cost)}
                                            </div>
                                        </div>
                                        {entry.task && (
                                            <div className="mt-2 text-xs text-slate-500 bg-slate-800/50 rounded px-2 py-1 inline-block">
                                                Task: {entry.task}
                                            </div>
                                        )}
                                    </div>
                                ))
                            ) : (
                                <div className="p-8 text-center text-slate-500">
                                    <Zap className="w-8 h-8 mx-auto mb-2 opacity-20" />
                                    <p>No recent activity recorded</p>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </main>
    );
}
